// Firebase console → Project settings → Your apps → Web app → config ကို ဒီမှာ ကူးထည့်ပါ။
// ဗလာထားရင် app က DEMO MODE (browser ထဲမှာပဲ data သိမ်း) နဲ့ run မယ်။
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// Cloud Functions region (functions/index.js နဲ့ တူရမယ်)
export const functionsRegion = "asia-southeast1";

// Base map. Leave maptilerKey empty to use free OpenStreetMap tiles (internal use).
// For the paid SaaS, create a free key at https://cloud.maptiler.com and restrict it to your domain.
export const mapTiles = {
  provider: "",        // "", "osm", "maptiler", "carto"  ("" = maptiler if key set, else osm)
  maptilerKey: "",
};
