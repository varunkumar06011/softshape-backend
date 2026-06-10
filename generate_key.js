const { generateKeyPairSync } = require('crypto');
const fs = require('fs');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});

fs.appendFileSync('.env', '\nQZ_PRIVATE_KEY="' + privateKey.replace(/\n/g, '\\n') + '"\n');
console.log('Key appended to .env');
