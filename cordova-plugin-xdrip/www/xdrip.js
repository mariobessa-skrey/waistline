var exec = require('cordova/exec');

var XDrip = {
  isAvailable: function(success, error) {
    exec(success, error, 'XDripBroadcast', 'isAvailable', []);
  },
  register: function(success, error) {
    exec(success, error, 'XDripBroadcast', 'register', []);
  },
  /**
   * Send a carb treatment to xDrip+ via broadcast intent.
   * @param {number} carbs - Carbohydrate amount in grams
   * @param {number} timestamp - Timestamp in milliseconds since epoch
   * @param {Function} success
   * @param {Function} error
   */
  addTreatment: function(carbs, timestamp, success, error) {
    exec(success, error, 'XDripBroadcast', 'addTreatment', [carbs, timestamp]);
  }
};

module.exports = XDrip;
