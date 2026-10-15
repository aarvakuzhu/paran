// Fill these in from Google Cloud Console (see README.md, "Google Cloud setup").
// Leave CLIENT_ID empty to run in demo mode only (data stays in this browser).
export const CONFIG = {
  CLIENT_ID: `329365162340-knfv8v5juqt0nmlnruakbsp12o9nvk61.apps.googleusercontent.com`,       // OAuth 2.0 Client ID (Web application), ends with .apps.googleusercontent.com
  API_KEY: `AIzaSyCcaHYDWy1h3BFsIB0u5AA84EtDEWMr1k0`,         // API key restricted to the Google Picker API (only needed to join a shared inventory)
  APP_ID: `329365162340`,          // Google Cloud project NUMBER (digits only), used by the Picker

  APP_NAME: `Paran`,
  ROOT_FOLDER_NAME: `Stash – Home Inventory`,
  SHEET_NAME: `Stash Inventory`,
};

export const SCOPES = [
  `https://www.googleapis.com/auth/drive.file`, // only files this app creates or the user picks
  `openid`,
  `email`,
  `profile`,
].join(` `);
