/*
  Copyright 2024 David Healey

  This file is part of Waistline.

  Waistline is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Waistline is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with app.  If not, see <http://www.gnu.org/licenses/>.
*/

app.Nightscout = {

  _timers: {},

  isEnabled: function() {
    return app.Settings.get("integration", "nightscout-enabled") === true;
  },

  getConfig: function() {
    let url = app.Settings.get("integration", "nightscout-url") || "";
    let secret = app.Settings.get("integration", "nightscout-secret") || "";
    let debounce = parseInt(app.Settings.get("integration", "nightscout-debounce")) || 30;
    return { url: url.replace(/\/+$/, ""), secret: secret, debounce: debounce };
  },

  sha1: async function(str) {
    let buffer = new TextEncoder().encode(str);
    let hashBuffer = await crypto.subtle.digest("SHA-1", buffer);
    let hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
  },

  /**
   * Called from diary mutation points. Groups items by meal category
   * and schedules a debounced sync for each affected category.
   */
  syncDiaryEntry: function(entry) {
    if (!this.isEnabled()) return;

    let config = this.getConfig();
    if (!config.url || !config.secret) return;

    // Determine which categories have items
    let categories = {};
    if (entry.items) {
      entry.items.forEach(function(item) {
        let category = item.category !== undefined ? item.category : 0;
        categories[category] = true;
      });
    }

    // Also include categories that had previous Nightscout IDs (items may have been deleted)
    if (entry.nightscoutIds) {
      for (let cat in entry.nightscoutIds) {
        categories[cat] = true;
      }
    }

    // Schedule debounced sync for each category
    let debounceMs = config.debounce * 1000;
    for (let category in categories) {
      this.scheduleMealSync(entry, category, debounceMs);
    }
  },

  scheduleMealSync: function(entry, category, debounceMs) {
    let dateKey = entry.dateTime instanceof Date
      ? entry.dateTime.toISOString()
      : new Date(entry.dateTime).toISOString();
    let key = dateKey + "-" + category;

    if (this._timers[key]) clearTimeout(this._timers[key]);

    let self = this;
    this._timers[key] = setTimeout(function() {
      delete self._timers[key];
      self.writeMealTreatment(entry, parseInt(category));
    }, debounceMs);
  },

  writeMealTreatment: async function(entry, category) {
    try {
      let config = this.getConfig();
      if (!config.url || !config.secret) return;

      let apiSecretHash = await this.sha1(config.secret);

      // Re-read entry from DB to get latest state
      let dateTime = entry.dateTime instanceof Date ? entry.dateTime : new Date(entry.dateTime);
      let d = new Date(Date.UTC(dateTime.getFullYear(), dateTime.getMonth(), dateTime.getDate()));
      let currentEntry = await dbHandler.get("diary", "dateTime", d);
      if (!currentEntry) return;

      // Get items for this category
      let items = [];
      if (currentEntry.items) {
        currentEntry.items.forEach(function(item) {
          let itemCategory = item.category !== undefined ? item.category : 0;
          if (itemCategory === category) {
            items.push(item);
          }
        });
      }

      // Delete existing Nightscout treatment for this category if we have an ID
      currentEntry.nightscoutIds = currentEntry.nightscoutIds || {};
      let existingId = currentEntry.nightscoutIds[category];
      if (existingId) {
        await this.deleteTreatment(config.url, apiSecretHash, existingId);
        delete currentEntry.nightscoutIds[category];
      }

      // If no items in this category, just save and return
      if (items.length === 0) {
        await dbHandler.put(currentEntry, "diary");
        return;
      }

      // Calculate nutrition for this meal
      let nutrition = await app.FoodsMealsRecipes.getTotalNutrition(items, "ignore");
      let excludeCarbs = app.Settings.get("integration", "xdrip-exclude-carbs") === true;
      let carbs = excludeCarbs ? 0 : Math.round((nutrition.carbohydrates || 0) * 100) / 100;
      let protein = Math.round((nutrition.proteins || 0) * 100) / 100;
      let fat = Math.round((nutrition.fat || 0) * 100) / 100;
      let calories = Math.round(nutrition.calories || 0);

      if (carbs <= 0 && protein <= 0 && fat <= 0 && calories <= 0) {
        await dbHandler.put(currentEntry, "diary");
        return;
      }

      // Find the last food timestamp in this meal
      let lastTimestamp = null;
      items.forEach(function(item) {
        if (item.dateTime) {
          let dt = new Date(item.dateTime);
          if (!lastTimestamp || dt > lastTimestamp) {
            lastTimestamp = dt;
          }
        }
      });

      if (!lastTimestamp) {
        let fallback = new Date(currentEntry.dateTime);
        fallback.setHours(12, 0, 0, 0);
        lastTimestamp = fallback;
      }

      // Get meal name for notes
      let mealNames = app.Settings.get("diary", "meal-names") || [];
      let mealName = mealNames[category] || "Meal " + category;

      // Build treatment object
      let treatment = {
        eventType: "Meal Bolus",
        created_at: lastTimestamp.toISOString(),
        carbs: carbs,
        protein: protein,
        fat: fat,
        notes: "Waistline " + mealName + ": " + calories + " kcal",
        enteredBy: "Waistline"
      };

      // POST treatment to Nightscout
      let newId = await this.postTreatment(config.url, apiSecretHash, treatment);

      if (newId) {
        currentEntry.nightscoutIds[category] = newId;
      }

      await dbHandler.put(currentEntry, "diary");

    } catch (e) {
      console.warn("Nightscout sync failed:", e);
    }
  },

  postTreatment: async function(baseUrl, apiSecretHash, treatment) {
    try {
      let response = await app.Utils.timeoutFetch(baseUrl + "/api/v1/treatments.json", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-SECRET": apiSecretHash
        },
        body: JSON.stringify([treatment])
      });

      if (response.ok) {
        let data = await response.json();
        if (data && data.length > 0 && data[0]._id) {
          return data[0]._id;
        }
      } else {
        console.warn("Nightscout POST failed:", response.status);
      }
    } catch (e) {
      console.warn("Nightscout POST error:", e);
    }
    return null;
  },

  deleteTreatment: async function(baseUrl, apiSecretHash, treatmentId) {
    try {
      let response = await app.Utils.timeoutFetch(baseUrl + "/api/v1/treatments/" + treatmentId, {
        method: "DELETE",
        headers: {
          "API-SECRET": apiSecretHash
        }
      });

      if (!response.ok) {
        console.warn("Nightscout DELETE failed:", response.status);
      }
    } catch (e) {
      console.warn("Nightscout DELETE error:", e);
    }
  }
};
