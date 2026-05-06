// Provider factory. Adding a new provider means writing one file in this
// directory and adding it to the registry below.

const teller = require("./teller");
const saltedge = require("./saltedge");
const plaidLegacy = require("./plaid_legacy");

const REGISTRY = {
  teller,
  saltedge,
  plaid_legacy: plaidLegacy,
};

function getProvider(name) {
  const p = REGISTRY[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

function listProviders() {
  return Object.keys(REGISTRY);
}

module.exports = { getProvider, listProviders };
