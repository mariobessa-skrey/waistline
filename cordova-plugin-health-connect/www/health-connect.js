var exec = require('cordova/exec');

var HealthConnect = {
  isAvailable: function(success, error) {
    exec(success, error, 'HealthConnect', 'isAvailable', []);
  },
  requestPermission: function(success, error) {
    exec(success, error, 'HealthConnect', 'requestPermission', []);
  },
  /**
   * Write nutrition records to Health Connect, one per meal.
   * @param {Array} mealData - Array of {calories, timestamp} objects
   * @param {string} dateISO - ISO date string for the diary day
   * @param {Function} success
   * @param {Function} error
   */
  writeNutrition: function(mealData, dateISO, success, error) {
    exec(success, error, 'HealthConnect', 'writeNutrition', [mealData, dateISO]);
  }
};

module.exports = HealthConnect;
