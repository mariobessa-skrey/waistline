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

app.HealthConnect = {

  isEnabled: function() {
    return app.Settings.get("integration", "health-connect") === true;
  },

  /**
   * Sync diary entry to Health Connect, writing one NutritionRecord per meal.
   * Each meal's timestamp is the dateTime of the last food item in that meal.
   * This is fire-and-forget; errors are silently logged.
   */
  syncDiaryEntry: async function(entry) {
    if (!this.isEnabled()) return;
    if (!window.cordova || !cordova.plugins || !cordova.plugins.healthConnect) return;

    try {
      let result = await new Promise(function(resolve, reject) {
        cordova.plugins.healthConnect.isAvailable(resolve, reject);
      });

      if (!result || !result.available) return;

      // Group items by meal category
      let mealGroups = {};
      if (entry.items) {
        entry.items.forEach(function(item) {
          let category = item.category !== undefined ? item.category : 0;
          if (!mealGroups[category]) {
            mealGroups[category] = [];
          }
          mealGroups[category].push(item);
        });
      }

      // Calculate calories per meal and find last timestamp
      let mealData = [];
      for (let category in mealGroups) {
        let items = mealGroups[category];

        // Get nutrition total for this meal's items
        let nutrition = await app.FoodsMealsRecipes.getTotalNutrition(items, "ignore");
        let calories = nutrition.calories || 0;

        if (calories <= 0) continue;

        // Find the last recorded food timestamp in this meal
        let lastTimestamp = null;
        items.forEach(function(item) {
          if (item.dateTime) {
            let dt = new Date(item.dateTime);
            if (!lastTimestamp || dt > lastTimestamp) {
              lastTimestamp = dt;
            }
          }
        });

        // If no timestamp found on items, use noon of the diary day as fallback
        if (!lastTimestamp) {
          let d = new Date(entry.dateTime);
          d.setHours(12, 0, 0, 0);
          lastTimestamp = d;
        }

        mealData.push({
          calories: calories,
          timestamp: lastTimestamp.toISOString()
        });
      }

      let dateISO = entry.dateTime instanceof Date
        ? entry.dateTime.toISOString()
        : new Date(entry.dateTime).toISOString();

      await new Promise(function(resolve, reject) {
        cordova.plugins.healthConnect.writeNutrition(mealData, dateISO, resolve, reject);
      });

    } catch (e) {
      console.warn("Health Connect sync failed:", e);
    }
  }
};
