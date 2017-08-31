const info = require('../lib/log').info;
const request = require('request-promise-native');

module.exports = () => request
  .get('https://registry.npmjs.org/medic-configurer-beta')
    .then(res => {
      const json = JSON.parse(res);
      const latest = json['dist-tags'].latest;
      const current = require('../../package').version;

      info(`Current version: ${current}`);
      if(latest === current) {
        info('You are already on the latest version :¬)');
      } else {
        info(`New version available!  To install:
	npm install -g medic-configurer-beta`);
      }
    });
