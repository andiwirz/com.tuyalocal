'use strict';

const Homey = require('homey');

class TuyaDehumidifierApp extends Homey.App {
  async onInit() {
    this.log('Tuya Dehumidifier App initialized');
  }
}

module.exports = TuyaDehumidifierApp;
