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

  isEnabled: function() {
    return app.Settings.get("integration", "xdrip-enabled") === true;
  },

  /**
   * Called from the sync button. Sends carb data for a specific category immediately.
   */
  syncMealDirect: function(entry, category) {
    if (!this.isEnabled()) return;
    if (!window.cordova || !cordova.plugins || !cordova.plugins.xdrip) return;

    this.sendMealTreatment(entry, category);
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
