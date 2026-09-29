// Firebase console → Project settings → Your apps → Web app → config ကို ဒီမှာ ကူးထည့်ပါ။
// ဗလာထားရင် app က DEMO MODE (browser ထဲမှာပဲ data သိမ်း) နဲ့ run မယ်။
export const firebaseConfig = {
  apiKey: "AIzaSyB6pSiAGXtBG6om9CTKj6zz5RU-fRLIR1c",
  authDomain: "mapping-b41ce.firebaseapp.com",
  projectId: "mapping-b41ce",
  storageBucket: "mapping-b41ce.firebasestorage.app",
  messagingSenderId: "568631883956",
  appId: "1:568631883956:web:e0761d49b58691784dffe1",
};

// Cloud Functions region (functions/index.js နဲ့ တူရမယ်)
export const functionsRegion = "asia-southeast1";

// Base map. Leave maptilerKey empty to use free OpenStreetMap tiles (internal use).
// For the paid SaaS, create a free key at https://cloud.maptiler.com and restrict it to your domain.
export const mapTiles = {
  provider: "",        // "", "osm", "maptiler", "carto"  ("" = maptiler if key set, else osm)
  maptilerKey: "",
};
