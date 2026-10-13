// Rubriken (categories) and how a new product gets one suggested.
// Order here is the order on screen.

export const GROUPS = [
  { id: "food", name: "Food" },
  { id: "nonfood", name: "Non-Food" },
];

export const CATS = [
  { id: "konserven", name: "Konserven & Gläser", g: "food" },
  { id: "nudeln", name: "Nudeln, Reis & Getreide", g: "food" },
  { id: "backen", name: "Backen & Zucker", g: "food" },
  { id: "gewuerze", name: "Gewürze", g: "food" },
  { id: "saucen", name: "Öl, Essig & Saucen", g: "food" },
  { id: "fruehstueck", name: "Frühstück & Aufstriche", g: "food" },
  { id: "suesses", name: "Süßes & Snacks", g: "food" },
  { id: "kaffee", name: "Kaffee & Tee", g: "food" },
  { id: "getraenke", name: "Alkoholfreie Getränke", g: "food" },
  { id: "alkohol", name: "Alkoholische Getränke", g: "food" },
  { id: "food-sonst", name: "Sonstiges Essen", g: "food" },
  { id: "haushalt", name: "Haushalt & Reinigung", g: "nonfood" },
  { id: "bad", name: "Bad & Körperpflege", g: "nonfood" },
  { id: "papier", name: "Papierwaren", g: "nonfood" },
  { id: "nonfood-sonst", name: "Sonstiges Non-Food", g: "nonfood" },
];
export const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));

const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const words = s => norm(s).split(/[^a-z]+/).filter(w => w.length > 2);

// Word stems in product names. The longest matching stem wins, so
// "Weinessig" lands in Saucen (essig) and not in Alkohol (wein).
const KEYWORDS = {
  konserven: ["dose", "konserve", "tomatenmark", "passiert", "tomaten", "pizzatomate", "mais", "bohnen", "kichererbsen", "linsen in", "erbsen", "thunfisch", "sardinen", "ravioli", "eintopf", "suppe", "gurken", "oliven", "kapern", "rotkohl", "sauerkraut", "pfirsiche", "ananas", "kokosmilch", "apfelmus"],
  nudeln: ["nudel", "spaghetti", "penne", "fusilli", "farfalle", "tagliatelle", "lasagne", "makkaroni", "spatzle", "reis", "risotto", "basmati", "couscous", "bulgur", "quinoa", "linsen", "polenta", "haferflocken", "gnocchi", "kartoffelpuree", "knodel"],
  backen: ["mehl", "zucker", "backpulver", "hefe", "vanillezucker", "puderzucker", "speisestarke", "starke", "kakao", "backmischung", "gelatine", "streusel", "mandeln gemahlen", "haselnusse gemahlen", "backpapier"],
  gewuerze: ["salz", "pfeffer", "paprika", "curry", "oregano", "basilikum", "thymian", "rosmarin", "zimt", "muskat", "kreuzkummel", "kurkuma", "chili", "gewurz", "bruhe", "fond", "lorbeer", "knoblauchpulver", "petersilie", "schnittlauch", "dill", "vanille"],
  saucen: ["essig", "ol ", "olivenol", "rapsol", "sonnenblumenol", "ketchup", "senf", "mayo", "remoulade", "sojasauce", "sojasosse", "sauce", "sosse", "pesto", "dressing", "balsamico", "worcester", "tabasco", "sirup"],
  fruehstueck: ["musli", "muesli", "cornflakes", "granola", "marmelade", "konfiture", "honig", "nutella", "nuss-nougat", "aufstrich", "erdnussbutter", "knackebrot", "zwieback"],
  suesses: ["schokolade", "schoko", "kinder", "riegel", "keks", "cookie", "chips", "flips", "salzstangen", "gummi", "haribo", "bonbon", "praline", "waffel", "nusse", "studentenfutter", "popcorn", "kuchen", "lebkuchen", "country", "duplo", "snickers", "mars", "twix", "milka", "ritter sport"],
  kaffee: ["kaffee", "espresso", "cappuccino", "tee", "kakaopulver", "kaffeepads", "kapseln"],
  getraenke: ["wasser", "mineralwasser", "sprudel", "saft", "nektar", "schorle", "limo", "limonade", "cola", "fanta", "sprite", "eistee", "tonic", "ginger ale", "radler alkoholfrei", "alkoholfrei", "quelle", "energy"],
  alkohol: ["wein", "rotwein", "weisswein", "rose", "sekt", "prosecco", "champagner", "bier", "pils", "weizen", "helles", "radler", "gin", "rum", "wodka", "vodka", "whisky", "whiskey", "likor", "schnaps", "korn", "obstler", "aperol", "campari", "lillet", "portwein", "sherry", "cognac", "brandy", "tequila", "amaretto", "baileys", "jagermeister", "glühwein", "gluhwein"],
  haushalt: ["spulmittel", "spulmaschine", "tabs", "waschmittel", "weichspuler", "reiniger", "putzmittel", "allzweck", "entkalker", "mullbeutel", "mulltuten", "schwamm", "lappen", "alufolie", "frischhaltefolie", "gefrierbeutel", "batterie", "gluhbirne", "kerze", "streichholz", "feuerzeug", "spülmittel"],
  bad: ["shampoo", "duschgel", "seife", "zahnpasta", "zahncreme", "zahnburste", "deo", "deodorant", "creme", "lotion", "rasier", "spulung", "haarspray", "watte", "wattestabchen", "binden", "tampons", "pflaster", "sonnencreme", "bodylotion", "handcreme", "mundspulung", "zahnseide"],
  papier: ["toilettenpapier", "klopapier", "kuchenrolle", "kuchentucher", "taschentucher", "servietten", "papiertucher", "tempo", "zewa", "feuchttucher"],
};

// Open Food Facts category tags (English ids), checked in this order.
const TAGS = [
  ["alkohol", ["alcoholic-beverages", "wines", "beers", "spirits", "liqueurs", "sparkling-wines", "ciders"]],
  ["kaffee", ["coffees", "teas", "herbal-teas", "instant-coffees"]],
  ["getraenke", ["waters", "juices", "sodas", "soft-drinks", "beverages", "nectars", "iced-teas"]],
  ["gewuerze", ["spices", "herbs", "salts", "seasonings", "broths", "bouillon"]],
  ["saucen", ["vinegars", "vegetable-oils", "olive-oils", "sauces", "condiments", "mustards", "ketchup", "mayonnaises", "dressings", "syrups"]],
  ["backen", ["flours", "sugars", "baking", "yeasts", "starches"]],
  ["fruehstueck", ["breakfast-cereals", "mueslis", "jams", "honeys", "spreads", "sweet-spreads", "hazelnut-spreads", "breakfasts"]],
  ["suesses", ["chocolates", "candies", "confectioneries", "biscuits", "cookies", "snacks", "sweet-snacks", "salty-snacks", "chips", "crisps", "chocolate-candies", "bars"]],
  ["nudeln", ["pastas", "rices", "grains", "cereal-grains", "legumes", "dried-pulses", "couscous", "flakes"]],
  ["konserven", ["canned-foods", "canned", "tomato-pastes", "tomato-sauces", "preserves", "pickles", "soups", "canned-vegetables", "canned-fruits", "canned-fishes"]],
];

function fromKeywords(name) {
  const n = " " + norm(name) + " ";
  let best = null, len = 0;
  for (const [cat, list] of Object.entries(KEYWORDS)) {
    for (const k of list) if (n.includes(k) && k.length > len) { best = cat; len = k.length; }
  }
  return best;
}

function fromTags(tags) {
  if (!tags?.length) return null;
  const t = tags.join(" ");
  for (const [cat, keys] of TAGS) if (keys.some(k => t.includes(":" + k) || t.includes("-" + k))) return cat;
  return null;
}

// What you sorted before wins: words of the new name vote for the
// categories of existing items that share those words.
function fromHistory(name, items) {
  const mine = new Set(words(name));
  if (!mine.size) return null;
  const votes = {};
  for (const it of items) {
    if (!it.cat) continue;
    for (const w of new Set(words(it.name))) if (mine.has(w)) votes[it.cat] = (votes[it.cat] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

export function suggestCategory(name, { tags = [], source = "" } = {}, items = []) {
  return fromHistory(name, items)
    || fromTags(tags)
    || fromKeywords(name)
    || (source.includes("beauty") ? "bad" : source.includes("products") ? "haushalt" : null);
}

// Bottles you pour from get a fill level; everything else is counted.
const FILL = ["wein", "sekt", "prosecco", "gin", "rum", "wodka", "vodka", "whisky", "whiskey", "likor", "schnaps", "korn", "aperol", "campari", "lillet", "portwein", "cognac", "brandy", "tequila", "amaretto", "baileys", "jagermeister", "olivenol", "rapsol", "sonnenblumenol", "essig", "balsamico", "sirup", "sojasauce", "spulmittel", "waschmittel", "weichspuler", "shampoo", "duschgel"];
export function suggestPack(name) {
  const n = norm(name);
  if (FILL.some(k => n.includes(k))) return { mode: "fill" };
  return { mode: "count" };
}
