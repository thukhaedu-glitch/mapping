// Myanmar administrative helpers: division (state / region) from a city or township name.
// Used when a store has no "division" of its own. Keys are lower-case, spaces removed.

export const DIVISIONS = [
  "Yangon Region", "Mandalay Region", "Naypyitaw Union Territory", "Ayeyarwady Region", "Bago Region", "Magway Region",
  "Sagaing Region", "Tanintharyi Region", "Kachin State", "Kayah State", "Kayin State", "Chin State", "Mon State",
  "Rakhine State", "Shan State",
];

const CITY = {
  yangon: "Yangon Region", rangoon: "Yangon Region", ရန်ကုန်: "Yangon Region", thanlyin: "Yangon Region", hmawbi: "Yangon Region",
  hlegu: "Yangon Region", taikkyi: "Yangon Region", twante: "Yangon Region", kyauktan: "Yangon Region",
  mandalay: "Mandalay Region", မန္တလေး: "Mandalay Region", pyinoolwin: "Mandalay Region", meiktila: "Mandalay Region",
  myingyan: "Mandalay Region", kyaukse: "Mandalay Region", nyaunguu: "Mandalay Region", bagan: "Mandalay Region", yamethin: "Mandalay Region",
  naypyitaw: "Naypyitaw Union Territory", naypyidaw: "Naypyitaw Union Territory", နေပြည်တော်: "Naypyitaw Union Territory",
  pyinmana: "Naypyitaw Union Territory", lewe: "Naypyitaw Union Territory",
  pathein: "Ayeyarwady Region", hinthada: "Ayeyarwady Region", myaungmya: "Ayeyarwady Region", maubin: "Ayeyarwady Region", pyapon: "Ayeyarwady Region",
  bago: "Bago Region", pegu: "Bago Region", ပဲခူး: "Bago Region", pyay: "Bago Region", taungoo: "Bago Region", toungoo: "Bago Region",
  magway: "Magway Region", magwe: "Magway Region", pakokku: "Magway Region", minbu: "Magway Region", chauk: "Magway Region", yenangyaung: "Magway Region",
  sagaing: "Sagaing Region", monywa: "Sagaing Region", shwebo: "Sagaing Region", kalay: "Sagaing Region", kale: "Sagaing Region",
  dawei: "Tanintharyi Region", myeik: "Tanintharyi Region", kawthaung: "Tanintharyi Region",
  myitkyina: "Kachin State", bhamo: "Kachin State", putao: "Kachin State",
  loikaw: "Kayah State",
  hpaan: "Kayin State", paan: "Kayin State", myawaddy: "Kayin State",
  hakha: "Chin State", falam: "Chin State",
  mawlamyine: "Mon State", moulmein: "Mon State", thaton: "Mon State", kyaikto: "Mon State",
  sittwe: "Rakhine State", kyaukphyu: "Rakhine State", thandwe: "Rakhine State", ngapali: "Rakhine State",
  taunggyi: "Shan State", lashio: "Shan State", kengtung: "Shan State", tachileik: "Shan State", muse: "Shan State",
  inle: "Shan State", nyaungshwe: "Shan State", kalaw: "Shan State",
};

// Yangon / Mandalay townships people often type in the City column
const YGN_TSP = ["ahlone", "bahan", "botataung", "dagon", "dagonseikkan", "dawbon", "hlaing", "hlaingtharyar", "insein", "kamayut", "kamaryut", "kyauktada",
  "kyimyindaing", "lanmadaw", "latha", "mayangone", "mingaladon", "mingalartaungnyunt", "northdagon", "northokkalapa", "pabedan", "pazundaung",
  "sanchaung", "seikkan", "shwepyitha", "southdagon", "southokkalapa", "tamwe", "thaketa", "thingangyun", "yankin", "eastdagon", "thuwunna"];
const MDY_TSP = ["chanayethazan", "chanmyathazi", "mahaaungmye", "aungmyethazan", "pyigyitagon", "amarapura", "patheingyi"];
YGN_TSP.forEach(t => (CITY[t] = "Yangon Region"));
MDY_TSP.forEach(t => (CITY[t] = "Mandalay Region"));

const norm = s => String(s || "").toLowerCase().replace(/\s|-|'|’|\./g, "");

/** A store's division: its own field, else looked up from city, then township. */
export function divisionOf(store) {
  if (store.division) return store.division;
  return CITY[norm(store.city)] || CITY[norm(store.township)] || "";
}
