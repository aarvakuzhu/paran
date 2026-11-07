// Fill these in from Google Cloud Console (see README.md, "Google Cloud setup").
// Leave CLIENT_ID empty to run in demo mode only (data stays in this browser).
export const CONFIG = {
  CLIENT_ID: `329365162340-knfv8v5juqt0nmlnruakbsp12o9nvk61.apps.googleusercontent.com`,       // OAuth 2.0 Client ID (Web application), ends with .apps.googleusercontent.com
  API_KEY: `AIzaSyCcaHYDWy1h3BFsIB0u5AA84EtDEWMr1k0`,         // API key restricted to the Google Picker API (only needed to join a shared inventory)
  APP_ID: `329365162340`,          // Google Cloud project NUMBER (digits only), used by the Picker

  APP_NAME: `Paran`,
  PUBLISHER: `GoliGundu LLC`,                 // shown on About and in the privacy notice
  CONTACT_EMAIL: `goligundu.llc@gmail.com`,   // privacy questions and deletion requests
  PRIVACY_URL: `./privacy.html`,              // the full privacy policy (also the URL given to Google Play)
  // Names used when creating a NEW inventory. Existing ones are found by their Drive tag
  // (appProperties.stash), never by name, so inventories created as "Stash" keep working unchanged.
  ROOT_FOLDER_NAME: `Paran Inventory`,
  SHEET_NAME: `Paran Inventory`,
  LEGACY_SHEET_NAME: `Stash Inventory`, // early pilot inventories; still offered when joining

  // Licensing (Urimam): usage counts, the people an owner shares with, and the owner's plan.
  // Empty = off: nothing is sent and the app behaves as before. `stub` = an in-browser stand-in for testing.
  LICENSE_URL: `https://license.goligundu.com/v1`,
  LICENSE_APP_ID: `paran`,
  // the server's public signing key(s) (JWKS entries), so checks verify on first open offline
  LICENSE_KEYS: [{ kty: `EC`, crv: `P-256`, x: `_kF04K_4to26lyYi85bFXBis5BBu0-TO10in21Sd-cM`, y: `Uc2bGxkr8rEyuy-UnR740-qXEjfqi2j4I2CxIAXt7ZI`, kid: `lic-2026-11-07`, alg: `ES256`, use: `sig` }],
  LICENSE_FAIL_OPEN_DAYS: null,  // pilot: no limit. Once enforced, an owner unchecked for 7 days has sharing paused.
};

export const SCOPES = [
  `https://www.googleapis.com/auth/drive.file`, // only files this app creates or the user picks
  `openid`,
  `email`,
  `profile`,
].join(` `);
