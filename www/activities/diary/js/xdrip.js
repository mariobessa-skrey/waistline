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

app.XDrip = {

  _timers: {},

  isEnabled: function() {
    return app.Settings.get("integration", "xdrip-enabled") === true;
  },

  /**
   * Called from diary mutation points. Groups items by meal category
   * and schedules a debounced sync for each affected category.
   * Uses the same debounce timer as Nightscout.
   */
  syncDiaryEntry: function(entry) {
    if (!this.isEnabled()) return;
    if (!window.cordova || !cordova.plugins || !cordova.plugins.xdrip) return;

    // Determine which categories have items
    let categories = {};
    if (entry.items) {
      entry.items.forEach(function(item) {
        let category = item.category !== undefined ? item.category : 0;
        categories[category] = true;
      });
    }

    // Get debounce from Nightscout settings (shared timer)
    let debounce = parseInt(app.Settings.get("integration", "nightscout-debounce")) || 30;
    let debounceMs = debounce * 1000;

    for (let category in categories) {
      this.scheduleMealSync(entry, parseInt(category), debounceMs);
    }
  },

  scheduleMealSync: function(entry, category, debounceMs) {
    let dateKey = entry.dateTime instanceof Date
      ? entry.dateTime.toISOString()
      : new Date(entry.dateTime).toISOString();
    let key = dateKey + "-" + category;

    if (this._timers[key]) clearTimeout(this._timers[key]);

    var self = this;
    this._timers[key] = setTimeout(function() {
      delete self._timers[key];
      self.sendMealTreatment(entry, category);
    }, debounceMs);
  },

  sendMealTreatment: async function(entry, category) {
    try {
      if (!window.cordova || !cordova.plugins || !cordova.plugins.xdrip) return;

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

      if (items.length === 0) return;

      // Calculate nutrition for this meal
      let nutrition = await app.FoodsMealsRecipes.getTotalNutrition(items, "ignore");
      let carbs = Math.round((nutrition.carbohydrates || 0) * 100) / 100;

      if (carbs <= 0) return;

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

      // Send carbs to xDrip+ via broadcast intent
      await new Promise(function(resolve, reject) {
        cordova.plugins.xdrip.addTreatment(carbs, lastTimestamp.getTime(), resolve, reject);
      });

    } catch (e) {
      console.warn("xDrip+ sync failed:", e);
    }
  }
};
