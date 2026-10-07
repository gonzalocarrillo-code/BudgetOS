import { z } from "zod";
import { CAMPAIGN_DIMENSION, NamingConventionDelimiter, NamingConventionToken, NamingConventionWriteResponse, type ConventionProblem, type CreateNamingConventionInput, type ExplainedPart } from "./matching.js";

/**
 * EX-6 (ADR-0091): built-in dictionaries for campaign-name tokens. A dimension of a known kind
 * (country, language, region, platform, channel, objective, audience, funnel stage, device, month,
 * quarter, year) reads its tokens through the kind's dictionary, so nobody types the list of
 * countries or languages again: "UK", "GBR", "Reino Unido" and "United Kingdom" are all `GB`.
 * Tokens compare case-, accent- and punctuation-insensitively (`normalizeToken`). Static data plus
 * the runtime's `Intl.DisplayNames` (English, Spanish, Portuguese and native names); no dependency.
 *
 * A token of a convention position resolves in this order: the workspace's alias for that position
 * (`NamingConventionToken.aliases`, editable) > the dimension's registry values (code, label, value
 * aliases) > the dimension kind's dictionary (landing on the registry's own value when it has one
 * for that entry, else on the dictionary's canonical code, which the convention save adds to the
 * registry) > unresolved.
 */

export const DictionaryKind = z.enum(["country", "language", "region", "platform", "channel", "objective", "audience", "funnel_stage", "device", "month", "quarter", "year"]);
export type DictionaryKind = z.infer<typeof DictionaryKind>;

/** Lower case, no accents, letters and digits only: "Côte d'Ivoire" → "cotedivoire", "Non-Brand" → "nonbrand". */
export function normalizeToken(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface Entry {
  code: string;
  label: string;
  synonyms: string[];
}

interface Dictionary {
  entries: Entry[];
  /** normalized token → entry index; the first writer wins (codes before names). */
  index: Map<string, number>;
}

/** ISO 3166-1: alpha-2 and alpha-3, every assigned code. */
const ISO_3166 =
  "AF AFG,AX ALA,AL ALB,DZ DZA,AS ASM,AD AND,AO AGO,AI AIA,AQ ATA,AG ATG,AR ARG,AM ARM,AW ABW,AU AUS,AT AUT,AZ AZE,BS BHS,BH BHR,BD BGD,BB BRB,BY BLR,BE BEL,BZ BLZ,BJ BEN,BM BMU,BT BTN,BO BOL,BQ BES,BA BIH,BW BWA,BV BVT,BR BRA,IO IOT,BN BRN,BG BGR,BF BFA,BI BDI,CV CPV,KH KHM,CM CMR,CA CAN,KY CYM,CF CAF,TD TCD,CL CHL,CN CHN,CX CXR,CC CCK,CO COL,KM COM,CG COG,CD COD,CK COK,CR CRI,CI CIV,HR HRV,CU CUB,CW CUW,CY CYP,CZ CZE,DK DNK,DJ DJI,DM DMA,DO DOM,EC ECU,EG EGY,SV SLV,GQ GNQ,ER ERI,EE EST,SZ SWZ,ET ETH,FK FLK,FO FRO,FJ FJI,FI FIN,FR FRA,GF GUF,PF PYF,TF ATF,GA GAB,GM GMB,GE GEO,DE DEU,GH GHA,GI GIB,GR GRC,GL GRL,GD GRD,GP GLP,GU GUM,GT GTM,GG GGY,GN GIN,GW GNB,GY GUY,HT HTI,HM HMD,VA VAT,HN HND,HK HKG,HU HUN,IS ISL,IN IND,ID IDN,IR IRN,IQ IRQ,IE IRL,IM IMN,IL ISR,IT ITA,JM JAM,JP JPN,JE JEY,JO JOR,KZ KAZ,KE KEN,KI KIR,KP PRK,KR KOR,KW KWT,KG KGZ,LA LAO,LV LVA,LB LBN,LS LSO,LR LBR,LY LBY,LI LIE,LT LTU,LU LUX,MO MAC,MG MDG,MW MWI,MY MYS,MV MDV,ML MLI,MT MLT,MH MHL,MQ MTQ,MR MRT,MU MUS,YT MYT,MX MEX,FM FSM,MD MDA,MC MCO,MN MNG,ME MNE,MS MSR,MA MAR,MZ MOZ,MM MMR,NA NAM,NR NRU,NP NPL,NL NLD,NC NCL,NZ NZL,NI NIC,NE NER,NG NGA,NU NIU,NF NFK,MK MKD,MP MNP,NO NOR,OM OMN,PK PAK,PW PLW,PS PSE,PA PAN,PG PNG,PY PRY,PE PER,PH PHL,PN PCN,PL POL,PT PRT,PR PRI,QA QAT,RE REU,RO ROU,RU RUS,RW RWA,BL BLM,SH SHN,KN KNA,LC LCA,MF MAF,PM SPM,VC VCT,WS WSM,SM SMR,ST STP,SA SAU,SN SEN,RS SRB,SC SYC,SL SLE,SG SGP,SX SXM,SK SVK,SI SVN,SB SLB,SO SOM,ZA ZAF,GS SGS,SS SSD,ES ESP,LK LKA,SD SDN,SR SUR,SJ SJM,SE SWE,CH CHE,SY SYR,TW TWN,TJ TJK,TZ TZA,TH THA,TL TLS,TG TGO,TK TKL,TO TON,TT TTO,TN TUN,TR TUR,TM TKM,TC TCA,TV TUV,UG UGA,UA UKR,AE ARE,GB GBR,US USA,UM UMI,UY URY,UZ UZB,VU VUT,VE VEN,VN VNM,VG VGB,VI VIR,WF WLF,EH ESH,YE YEM,ZM ZMB,ZW ZWE";

/** Names people use that no ISO table or display-name locale gives. */
const COUNTRY_EXTRA: Record<string, string[]> = {
  GB: ["UK", "England", "Inglaterra", "Scotland", "Escocia", "Wales", "Great Britain", "Britain", "Gran Bretaña", "Grã-Bretanha"],
  US: ["EEUU", "EE.UU.", "EUA", "U.S.", "U.S.A.", "United States of America", "Estados Unidos de America", "America"],
  AE: ["UAE", "EAU", "Emirates", "Emiratos", "Emirados"],
  SA: ["KSA"],
  NL: ["Holland", "Holanda"],
  KR: ["Korea", "South Korea", "Corea", "Corea del Sur", "Coreia", "Coreia do Sul"],
  KP: ["North Korea", "Corea del Norte", "Coreia do Norte"],
  CZ: ["Czech Republic", "Republica Checa", "Chequia", "Tchéquia"],
  TR: ["Turkey", "Türkiye", "Turquia"],
  CI: ["Ivory Coast", "Costa de Marfil", "Costa do Marfim"],
  MK: ["Macedonia", "North Macedonia"],
  SZ: ["Swaziland", "Eswatini"],
  MM: ["Burma", "Birmania"],
  CD: ["DRC", "DR Congo", "Congo Kinshasa"],
  CG: ["Congo Brazzaville"],
  HK: ["Hong Kong"],
  MO: ["Macau", "Macao"],
  PS: ["Palestine", "Palestina"],
  VA: ["Vatican", "Vaticano", "Vatican City"],
  RU: ["Russia", "Rusia", "Rússia"],
  VN: ["Vietnam", "Viet Nam"],
  CV: ["Cape Verde", "Cabo Verde"],
  TW: ["Taiwan"],
  IR: ["Iran"],
  SY: ["Syria", "Siria"],
  LA: ["Laos"],
  BO: ["Bolivia"],
  VE: ["Venezuela"],
  TZ: ["Tanzania"],
  MD: ["Moldova"],
};

/** ISO 639-1, every assigned code. */
const ISO_639_1 =
  "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu";

/** Three-letter codes (ISO 639-2/T and /B) and the abbreviations media plans use for the common languages. */
const LANGUAGE_EXTRA: Record<string, string[]> = {
  es: ["spa", "esp", "cas", "castellano", "castilian"],
  en: ["eng", "ing", "ingl"],
  pt: ["por", "port", "brazilian", "brasileño", "brasileiro"],
  fr: ["fra", "fre", "fran"],
  de: ["deu", "ger", "ale", "alem"],
  it: ["ita"],
  nl: ["nld", "dut", "hol"],
  ja: ["jpn", "jap"],
  zh: ["zho", "chi", "mandarin", "mandarín", "chinese simplified", "chinese traditional"],
  ko: ["kor"],
  ru: ["rus"],
  ar: ["ara"],
  hi: ["hin"],
  tr: ["tur"],
  pl: ["pol"],
  sv: ["swe"],
  no: ["nor"],
  da: ["dan"],
  fi: ["fin"],
  he: ["heb"],
  el: ["ell", "gre"],
  cs: ["ces", "cze"],
  hu: ["hun"],
  ro: ["ron", "rum"],
  th: ["tha"],
  vi: ["vie"],
  id: ["ind"],
  ms: ["msa", "may"],
  uk: ["ukr"],
  ca: ["cat"],
  eu: ["eus", "baq"],
  gl: ["glg"],
  bg: ["bul"],
  hr: ["hrv"],
  sr: ["srp"],
  sk: ["slk", "slo"],
  sl: ["slv"],
  et: ["est"],
  lv: ["lav"],
  lt: ["lit"],
  fa: ["fas", "per"],
  ur: ["urd"],
  bn: ["ben"],
  ta: ["tam"],
  te: ["tel"],
  tl: ["tgl", "fil", "filipino"],
  sw: ["swa"],
  af: ["afr"],
};

type Table = ReadonlyArray<readonly [code: string, label: string, synonyms: readonly string[]]>;

const REGIONS: Table = [
  ["AMER", "AMER", ["amer", "na", "nam", "noram", "north america", "norteamerica", "america do norte", "america del norte"]],
  ["LATAM", "LATAM", ["latam", "la", "lac", "latin america", "latinoamerica", "america latina", "south america", "sudamerica", "america do sul", "sam"]],
  ["EMEA", "EMEA", ["emea", "europe middle east africa"]],
  ["APAC", "APAC", ["apac", "asia pacific", "asia pacifico", "apj", "asia"]],
  ["EU", "Europe", ["eu", "eur", "europe", "europa"]],
  ["MENA", "MENA", ["mena", "middle east", "oriente medio", "medio oriente", "oriente medio y norte de africa"]],
  ["NORDICS", "Nordics", ["nordics", "nordic", "nordicos", "scandinavia", "escandinavia"]],
  ["DACH", "DACH", ["dach"]],
  ["BENELUX", "Benelux", ["benelux"]],
  ["ANZ", "ANZ", ["anz", "oceania"]],
  ["SEA", "Southeast Asia", ["sea", "southeast asia", "sudeste asiatico"]],
  ["CEE", "CEE", ["cee", "central eastern europe"]],
  ["AFRICA", "Africa", ["africa"]],
  ["GLOBAL", "Global", ["global", "gbl", "glb", "ww", "worldwide", "intl", "international", "internacional"]],
];

const PLATFORMS: Table = [
  ["meta", "Meta", ["meta", "fb", "facebook", "ig", "instagram", "fbig", "igfb", "metaads", "facebookads", "instagramads", "messenger", "audience network"]],
  ["google_ads", "Google Ads", ["google ads", "google", "gads", "gg", "ggl", "adwords", "yt", "youtube", "ytads", "pmax", "performance max", "gdn", "demand gen", "discovery"]],
  ["dv360", "DV360", ["dv360", "dv", "dbm", "display video 360"]],
  ["tiktok", "TikTok", ["tiktok", "tt", "tik", "tiktokads"]],
  ["snapchat", "Snapchat", ["snapchat", "snap", "sc", "snp"]],
  ["linkedin", "LinkedIn", ["linkedin", "li", "lnkd", "lkd", "lkdn"]],
  ["x", "X", ["x", "twitter", "tw", "twtr", "xads"]],
  ["pinterest", "Pinterest", ["pinterest", "pin", "pint", "pnt"]],
  ["amazon", "Amazon", ["amazon", "amz", "amzn", "amazonads", "amazon dsp"]],
  ["microsoft_ads", "Microsoft Ads", ["microsoft ads", "microsoft", "msads", "msft", "bing", "bingads"]],
  ["the_trade_desk", "The Trade Desk", ["the trade desk", "ttd", "tradedesk"]],
  ["programmatic", "Programmatic", ["programmatic", "prog", "prg", "pgm"]],
  ["reddit", "Reddit", ["reddit", "rdt"]],
  ["spotify", "Spotify", ["spotify"]],
  ["apple_search_ads", "Apple Search Ads", ["apple search ads", "asa", "apple"]],
  ["criteo", "Criteo", ["criteo"]],
  ["taboola", "Taboola", ["taboola"]],
  ["outbrain", "Outbrain", ["outbrain"]],
];

const CHANNELS: Table = [
  ["paid_social", "Paid social", ["paid social", "social", "ps", "sm", "social media", "rrss", "redes sociales", "redes sociais"]],
  ["paid_search", "Paid search", ["paid search", "search", "sem", "ppc", "busqueda", "busca"]],
  ["programmatic", "Programmatic", ["programmatic", "prog", "display", "pgm", "programatica"]],
  ["video", "Video", ["video", "olv", "online video"]],
  ["retail_media", "Retail media", ["retail media", "retail", "rm"]],
  ["affiliate", "Affiliate", ["affiliate", "aff", "afiliados"]],
  ["tv", "TV", ["tv", "television", "linear tv"]],
  ["ooh", "Out of home", ["ooh", "out of home", "outdoor", "via publica"]],
  ["dooh", "Digital out of home", ["dooh", "digital out of home"]],
  ["print", "Print", ["print", "press", "prensa", "impresso"]],
  ["radio", "Radio", ["radio", "audio"]],
  ["sponsorship", "Sponsorship", ["sponsorship", "patrocinio", "sponsoring"]],
];

const OBJECTIVES: Table = [
  ["brand", "Brand", ["brand", "branding", "brd", "marca"]],
  ["non_brand", "Non-brand", ["non brand", "nb", "nobrand", "generic", "generico", "genericas"]],
  ["competitor", "Competitor", ["competitor", "competitors", "comp", "competencia", "concorrencia", "conquest"]],
  ["awareness", "Awareness", ["awareness", "aw", "awa", "awr", "reach", "alcance", "reconocimiento", "conocimiento", "notoriedad", "reconhecimento"]],
  ["consideration", "Consideration", ["consideration", "cons", "consid", "consideracion", "consideracao", "traffic", "trafico", "trafego", "engagement", "eng", "video views", "vv"]],
  ["conversion", "Conversion", ["conversion", "conversions", "conv", "conversao", "conversiones", "sales", "ventas", "vendas", "purchase", "leads", "lead", "lead gen", "leadgen"]],
  ["retention", "Retention", ["retention", "ret", "retencion", "retencao", "loyalty", "fidelizacion", "fidelizacao"]],
];

const AUDIENCES: Table = [
  ["prospecting", "Prospecting", ["prospecting", "prosp", "prospect", "pros", "acquisition", "acq", "adquisicion", "aquisicao"]],
  ["retargeting", "Retargeting", ["retargeting", "rtg", "rt", "retarget", "remarketing", "rmkt", "remkt", "rmk"]],
  ["lookalike", "Lookalike", ["lookalike", "lookalikes", "lal", "lla", "similar"]],
  ["crm", "CRM", ["crm", "customers", "customer list", "clientes", "existing customers"]],
  ["broad", "Broad", ["broad", "open", "amplio", "aberto", "abierto"]],
];

const FUNNEL: Table = [
  ["upper", "Upper", ["upper", "tofu", "top", "upper funnel", "uf"]],
  ["mid", "Mid", ["mid", "mofu", "middle", "mid funnel", "mf"]],
  ["lower", "Lower", ["lower", "bofu", "bottom", "lower funnel", "lf"]],
];

const DEVICES: Table = [
  ["desktop", "Desktop", ["desktop", "dt", "dsk", "pc", "computer", "escritorio"]],
  ["mobile", "Mobile", ["mobile", "mob", "mb", "mbl", "mobl", "smartphone", "movil", "celular", "cel", "phone"]],
  ["tablet", "Tablet", ["tablet", "tab", "tbl"]],
  ["ctv", "Connected TV", ["ctv", "connected tv", "smart tv", "ott"]],
  ["all", "All devices", ["all devices", "all", "cross device", "multi device", "multidevice"]],
];

const MONTHS: Table = [
  ["01", "January", ["jan", "january", "ene", "enero", "janeiro"]],
  ["02", "February", ["feb", "february", "febrero", "fev", "fevereiro"]],
  ["03", "March", ["mar", "march", "marzo", "março"]],
  ["04", "April", ["apr", "april", "abr", "abril"]],
  ["05", "May", ["may", "mayo", "mai", "maio"]],
  ["06", "June", ["jun", "june", "junio", "junho"]],
  ["07", "July", ["jul", "july", "julio", "julho"]],
  ["08", "August", ["aug", "august", "ago", "agosto"]],
  ["09", "September", ["sep", "sept", "september", "septiembre", "set", "setiembre", "setembro"]],
  ["10", "October", ["oct", "october", "octubre", "out", "outubro"]],
  ["11", "November", ["nov", "november", "noviembre", "novembro"]],
  ["12", "December", ["dec", "december", "dic", "diciembre", "dez", "dezembro"]],
];

/** `Intl.DisplayNames(...).of(code)`, or null when the runtime has no name for it. */
function displayName(locale: string, type: "region" | "language", code: string): string | null {
  try {
    const name = new Intl.DisplayNames([locale], { type, fallback: "none" }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

const NAME_LOCALES = ["en", "es", "pt"] as const;

function build(entries: Entry[]): Dictionary {
  const index = new Map<string, number>();
  // Codes first, then synonyms in order: the first writer of a normalized token keeps it.
  entries.forEach((e, i) => {
    const k = normalizeToken(e.code);
    if (!index.has(k)) index.set(k, i);
  });
  const longest = Math.max(0, ...entries.map((e) => e.synonyms.length));
  for (let s = 0; s < longest; s++) {
    entries.forEach((e, i) => {
      const syn = e.synonyms[s];
      if (syn === undefined) return;
      const k = normalizeToken(syn);
      if (k !== "" && !index.has(k)) index.set(k, i);
    });
  }
  return { entries, index };
}

const fromTable = (table: Table): Entry[] => table.map(([code, label, synonyms]) => ({ code, label, synonyms: [label, ...synonyms] }));

function countries(): Entry[] {
  return ISO_3166.split(",").map((pair) => {
    const [a2 = "", a3 = ""] = pair.split(" ");
    const names = NAME_LOCALES.map((l) => displayName(l, "region", a2)).filter((n): n is string => n !== null);
    return { code: a2, label: names[0] ?? a2, synonyms: [a3, ...(COUNTRY_EXTRA[a2] ?? []), ...names] };
  });
}

function languages(): Entry[] {
  return ISO_639_1.split(" ").map((code) => {
    const names = [...NAME_LOCALES.map((l) => displayName(l, "language", code)), displayName(code, "language", code)].filter((n): n is string => n !== null);
    return { code, label: names[0] ?? code, synonyms: [...(LANGUAGE_EXTRA[code] ?? []), ...names] };
  });
}

const QUARTER = /^(?:q|qtr|quarter|t|trim|trimestre)([1-4])$|^([1-4])(?:q|t|qtr)$/;
const YEAR = /^(?:fy|y|ano|anio|year)?(20\d\d)$|^(?:fy|y)(\d\d)$/;

const BUILT: Partial<Record<DictionaryKind, Dictionary>> = {};
const TABLES: Record<Exclude<DictionaryKind, "quarter" | "year">, () => Entry[]> = {
  country: countries,
  language: languages,
  region: () => fromTable(REGIONS),
  platform: () => fromTable(PLATFORMS),
  channel: () => fromTable(CHANNELS),
  objective: () => fromTable(OBJECTIVES),
  audience: () => fromTable(AUDIENCES),
  funnel_stage: () => fromTable(FUNNEL),
  device: () => fromTable(DEVICES),
  month: () => fromTable(MONTHS),
};

function dictionary(kind: Exclude<DictionaryKind, "quarter" | "year">): Dictionary {
  const built = BUILT[kind];
  if (built) return built;
  const d = build(TABLES[kind]());
  BUILT[kind] = d;
  return d;
}

export interface DictionaryHit {
  /** The canonical code: ISO alpha-2 upper case for countries, ISO 639-1 lower case for languages, the default registry's codes for the rest. */
  code: string;
  label: string;
}

/** A token read with one dictionary, or null. */
export function lookupDictionary(kind: DictionaryKind, token: string): DictionaryHit | null {
  const k = normalizeToken(token);
  if (k === "") return null;
  if (kind === "quarter") {
    const m = QUARTER.exec(k);
    const q = m?.[1] ?? m?.[2];
    return q ? { code: `Q${q}`, label: `Q${q}` } : null;
  }
  if (kind === "year") {
    const m = YEAR.exec(k);
    const y = m?.[1] ?? (m?.[2] ? `20${m[2]}` : undefined);
    return y ? { code: y, label: y } : null;
  }
  const d = dictionary(kind);
  const i = d.index.get(k);
  const e = i === undefined ? undefined : d.entries[i];
  return e ? { code: e.code, label: e.label } : null;
}

/** Every normalized token that reads as this entry (its code and synonyms); empty for quarter / year or an unknown code. */
export function dictionarySynonyms(kind: DictionaryKind, code: string): Set<string> {
  if (kind === "quarter" || kind === "year") return new Set([normalizeToken(code)]);
  const e = dictionary(kind).entries.find((x) => x.code === code);
  return new Set(e ? [e.code, ...e.synonyms].map(normalizeToken).filter((s) => s !== "") : []);
}

/** How many entries a dictionary has (quarter and year are patterns: 4 and open). */
export function dictionarySize(kind: DictionaryKind): number | null {
  if (kind === "quarter") return 4;
  if (kind === "year") return null;
  return dictionary(kind).entries.length;
}

/** Dimension keys (normalized) → the dictionary kind they use, besides the kind's own name. */
const KIND_KEYS: Record<DictionaryKind, string[]> = {
  country: ["country", "countries", "market", "markets", "geo", "pais", "paises", "mercado", "cntry", "ctry", "nation"],
  language: ["language", "languages", "lang", "idioma", "lingua"],
  region: ["region", "regions", "area", "zone", "cluster", "regiao"],
  platform: ["platform", "platforms", "publisher", "network", "plataforma", "mediaplatform"],
  channel: ["channel", "channels", "canal", "mediatype", "media"],
  objective: ["objective", "objectives", "goal", "objetivo"],
  audience: ["audience", "audiences", "tactic", "targeting", "audiencia", "publico"],
  funnel_stage: ["funnelstage", "funnel", "stage", "embudo"],
  device: ["device", "devices", "dispositivo"],
  month: ["month", "mes"],
  quarter: ["quarter", "trimestre"],
  year: ["year", "ano", "anio", "fiscalyear"],
};

/**
 * The dictionary a dimension uses, from its key: the default granularities (country, region,
 * platform, channel, objective, audience, funnel_stage) and common synonyms (market → country,
 * lang → language). Null: the dimension has no dictionary (client, brand, campaign…).
 */
export function dictionaryKindFor(dimensionKey: string): DictionaryKind | null {
  const k = normalizeToken(dimensionKey);
  for (const kind of DictionaryKind.options) if (KIND_KEYS[kind].includes(k)) return kind;
  return null;
}

// ---- resolution -------------------------------------------------------------------------------

export interface RegistryValueRef {
  code: string;
  label: string | null;
  aliases: readonly string[];
}

export type TokenSource = "alias" | "registry" | "dictionary";

/** A token resolved to a value code. `known`: the code is a registry value; otherwise `label` is the dictionary's, for creating it. */
export interface TokenHit {
  code: string;
  source: "registry" | "dictionary";
  known: boolean;
  label?: string;
}

export type TokenResolver = (dimension: string, token: string) => TokenHit | null;

/**
 * Registry values (per dimension key) + the dimension's dictionary → a resolver. A token matches a
 * registry value by code, then value alias, then label (normalized); otherwise the dictionary of
 * the dimension's kind reads it, and its entry lands on the registry value whose code, label or
 * alias is any of the entry's synonyms (so a registry that says `UK` keeps `UK` for "GB"), else
 * on the dictionary's canonical code.
 */
export function makeTokenResolver(registry: Readonly<Record<string, readonly RegistryValueRef[]>>, kindFor: (dimension: string) => DictionaryKind | null = dictionaryKindFor): TokenResolver {
  const indexes = new Map<string, Map<string, string>>();
  for (const [dim, values] of Object.entries(registry)) {
    const m = new Map<string, string>();
    const put = (raw: string | null, code: string) => {
      const k = raw === null ? "" : normalizeToken(raw);
      if (k !== "" && !m.has(k)) m.set(k, code);
    };
    for (const v of values) put(v.code, v.code);
    for (const v of values) for (const a of v.aliases) put(a, v.code);
    for (const v of values) put(v.label, v.code);
    indexes.set(dim, m);
  }
  return (dimension, token) => {
    const k = normalizeToken(token);
    if (k === "") return null;
    const idx = indexes.get(dimension);
    const own = idx?.get(k);
    if (own !== undefined) return { code: own, source: "registry", known: true };
    const kind = kindFor(dimension);
    if (kind === null) return null;
    const hit = lookupDictionary(kind, token);
    if (hit === null) return null;
    if (idx) {
      for (const s of dictionarySynonyms(kind, hit.code)) {
        const code = idx.get(s);
        if (code !== undefined) return { code, source: "dictionary", known: true };
      }
    }
    return { code: hit.code, source: "dictionary", known: false, label: hit.label };
  };
}


export interface ExplainedName {
  dimensionValues: Record<string, string> | null;
  problem: ConventionProblem | null;
  /** Every part when the name has the convention's shape (unresolved ones too); empty otherwise. */
  parts: ExplainedPart[];
}

/**
 * A campaign name read with a convention, part by part: the position's alias (any case), then the
 * resolver (registry, then dictionary). Same shape rules as `parseCampaignName` (exactly one part
 * per position, none empty); unlike it, every part is reported, so the unresolved tokens of a name
 * can be listed. `dimensionValues` only when every named part resolved.
 */
export function explainCampaignName(
  convention: { delimiter: string; tokens: ReadonlyArray<{ dimension: string | null; aliases?: Record<string, string> | undefined }> },
  name: string,
  resolve: TokenResolver,
): ExplainedName {
  const raws = name.trim().split(convention.delimiter);
  if (raws.length !== convention.tokens.length) return { dimensionValues: null, problem: { kind: "parts", expected: convention.tokens.length, found: raws.length }, parts: [] };
  const empty = raws.findIndex((r) => r.trim() === "");
  if (empty >= 0) return { dimensionValues: null, problem: { kind: "empty", position: empty + 1 }, parts: [] };
  const parts: ExplainedPart[] = [];
  let problem: ConventionProblem | null = null;
  const dimensionValues: Record<string, string> = {};
  for (const [i, token] of convention.tokens.entries()) {
    const raw = (raws[i] ?? "").trim();
    if (token.dimension === null) {
      parts.push({ position: i + 1, raw, dimension: null, code: null, source: null });
      continue;
    }
    const k = normalizeToken(raw);
    const alias = Object.entries(token.aliases ?? {}).find(([a]) => normalizeToken(a) === k);
    const hit = resolve(token.dimension, alias ? alias[1] : raw);
    const code = hit?.code ?? null;
    parts.push({ position: i + 1, raw, dimension: token.dimension, code, source: hit === null ? null : alias ? "alias" : hit.source });
    if (code === null) problem ??= { kind: "unknown_value", position: i + 1, dimension: token.dimension, value: raw };
    else dimensionValues[token.dimension] = code;
  }
  return { dimensionValues: problem === null ? dimensionValues : null, problem, parts };
}

// ---- analysis ---------------------------------------------------------------------------------

export const PositionHit = z.object({
  /** The dictionary that reads the tokens; null when only the registry's own values do. */
  kind: DictionaryKind.nullable(),
  /** The registry dimension it proposes; null when the workspace has no dimension of that kind (a quarter, a language…). */
  dimension: z.string().nullable(),
  /** Share of the names whose token at this position it reads, 0..1. */
  hitRate: z.number(),
});
export type PositionHit = z.infer<typeof PositionHit>;

export const PositionAnalysis = z.object({
  position: z.number().int(),
  /** Distinct tokens (case- and accent-insensitive). */
  cardinality: z.number().int(),
  /** The most frequent tokens, as written. */
  examples: z.array(z.string()),
  hits: z.array(PositionHit),
  best: PositionHit.nullable(),
});
export type PositionAnalysis = z.infer<typeof PositionAnalysis>;

/** A proposed convention: like CreateNamingConventionInput, but it may have no named position. */
export const ConventionProposal = z.object({ delimiter: NamingConventionDelimiter, tokens: z.array(NamingConventionToken) });
export type ConventionProposal = z.infer<typeof ConventionProposal>;

export const NameAnalysis = z.object({
  delimiter: NamingConventionDelimiter,
  /** The usual number of parts; names with another count do not fit. */
  partCount: z.number().int(),
  total: z.number().int(),
  fitting: z.number().int(),
  positions: z.array(PositionAnalysis),
  proposal: ConventionProposal,
});
export type NameAnalysis = z.infer<typeof NameAnalysis>;

/** Delimiters in the order a tie prefers them. */
const DELIMITER_ORDER: NamingConventionDelimiter[] = ["_", "-", "|", ".", "/", ":", "·", "+", " "];
/** A position proposes a dimension when at least this share of the names reads through it. */
export const PROPOSE_AT = 0.5;

const round = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * "Analyze names" (deterministic, no AI): the delimiter that splits most names into the same
 * number (≥ 2) of parts; per position its cardinality, examples and the share of names each
 * dictionary — through the workspace's dimensions of that kind, or the registry's own values via
 * `inRegistry` — reads; and a proposed convention: each position gets the dimension with the best
 * hit rate (≥ 50%), each dimension at most once, the rest ignored.
 */
export function analyzeCampaignNames(
  names: readonly string[],
  dimensions: ReadonlyArray<{ key: string }>,
  inRegistry: (dimension: string, token: string) => boolean = () => false,
  delimiter?: NamingConventionDelimiter,
): NameAnalysis {
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))];
  const total = list.length;
  const pick = delimiter ? { d: delimiter, ...modal(list, delimiter) } : DELIMITER_ORDER.map((d) => ({ d, ...modal(list, d) })).reduce<{ d: NamingConventionDelimiter; count: number; freq: number } | null>((best, c) => (c.count >= 2 && (best === null || c.freq > best.freq || (c.freq === best.freq && c.count > best.count)) ? c : best), null);
  if (pick === null || total === 0 || pick.count < 2) return { delimiter: delimiter ?? "_", partCount: pick?.count ?? 0, total, fitting: 0, positions: [], proposal: { delimiter: delimiter ?? "_", tokens: [] } };
  const fitting = list.map((n) => n.split(pick.d)).filter((p) => p.length === pick.count);
  const dims = dimensions.filter((d) => d.key !== CAMPAIGN_DIMENSION);
  const boundKinds = new Set(dims.map((d) => dictionaryKindFor(d.key)).filter((k): k is DictionaryKind => k !== null));
  const positions: PositionAnalysis[] = [];
  for (let i = 0; i < pick.count; i++) {
    const tokens = fitting.map((p) => (p[i] ?? "").trim());
    const counts = new Map<string, { raw: string; n: number }>();
    for (const tk of tokens) {
      const k = normalizeToken(tk);
      const c = counts.get(k);
      if (c) c.n++;
      else counts.set(k, { raw: tk, n: 1 });
    }
    const rate = (reads: (tk: string) => boolean) => round(tokens.filter((tk) => tk !== "" && reads(tk)).length / tokens.length);
    const hits: PositionHit[] = [];
    for (const d of dims) {
      const kind = dictionaryKindFor(d.key);
      const r = rate((tk) => inRegistry(d.key, tk) || (kind !== null && lookupDictionary(kind, tk) !== null));
      if (r > 0) hits.push({ kind, dimension: d.key, hitRate: r });
    }
    for (const kind of DictionaryKind.options) {
      if (boundKinds.has(kind)) continue;
      const r = rate((tk) => lookupDictionary(kind, tk) !== null);
      if (r > 0) hits.push({ kind, dimension: null, hitRate: r });
    }
    const order = (h: PositionHit) => (h.kind === null ? DictionaryKind.options.length : DictionaryKind.options.indexOf(h.kind));
    hits.sort((a, b) => b.hitRate - a.hitRate || Number(b.dimension !== null) - Number(a.dimension !== null) || order(a) - order(b));
    const examples = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((c) => c.raw);
    positions.push({ position: i + 1, cardinality: counts.size, examples, hits: hits.slice(0, 3), best: hits[0] ?? null });
  }
  // Greedy: the strongest (position, dimension) pairs first, each position and dimension once.
  const pairs = positions.flatMap((p) => p.hits.filter((h) => h.dimension !== null && h.hitRate >= PROPOSE_AT).map((h) => ({ i: p.position - 1, dim: h.dimension as string, r: h.hitRate })));
  pairs.sort((a, b) => b.r - a.r || a.i - b.i);
  const chosen = new Map<number, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (chosen.has(p.i) || used.has(p.dim)) continue;
    chosen.set(p.i, p.dim);
    used.add(p.dim);
  }
  return {
    delimiter: pick.d,
    partCount: pick.count,
    total,
    fitting: fitting.length,
    positions,
    proposal: { delimiter: pick.d, tokens: positions.map((_, i) => ({ dimension: chosen.get(i) ?? null, aliases: {} })) },
  };
}

function modal(names: readonly string[], d: string): { count: number; freq: number } {
  const hist = new Map<number, number>();
  for (const n of names) {
    const c = n.split(d).length;
    hist.set(c, (hist.get(c) ?? 0) + 1);
  }
  let count = 0;
  let n = 0;
  for (const [c, f] of hist) if (f > n || (f === n && c > count)) [count, n] = [c, f];
  return { count, freq: names.length === 0 ? 0 : n / names.length };
}

// ---- API shapes -------------------------------------------------------------------------------

/** POST /workspaces/:ws/naming-conventions/analyze: the given names, or the workspace's campaign names (largest spend first). */
export const AnalyzeNamesInput = z.object({ names: z.array(z.string().min(1).max(500)).max(1000).optional(), delimiter: NamingConventionDelimiter.optional() }).strict();
export type AnalyzeNamesInput = z.infer<typeof AnalyzeNamesInput>;

export const AnalyzeNamesResponse = NameAnalysis.extend({ source: z.enum(["pasted", "facts"]) });
export type AnalyzeNamesResponse = z.infer<typeof AnalyzeNamesResponse>;


/** GET /workspaces/:ws/naming-convention: the workspace's convention (the newest live one) and whether "Suggest with AI" can run. */
export const NamingConventionState = z.object({
  convention: z
    .object({ id: z.string().uuid(), delimiter: NamingConventionDelimiter, tokens: z.array(NamingConventionToken), createdBy: z.string().uuid(), createdAt: z.string() })
    .nullable(),
  /** Older live conventions EX-5 allowed; matching still tries them after this one. */
  others: z.number().int(),
  aiAvailable: z.boolean(),
});
export type NamingConventionState = z.infer<typeof NamingConventionState>;

/** PUT /workspaces/:ws/naming-convention and POST …/aliases: the new convention, the re-match, and the registry values created from a dictionary. */
export const NamingConventionSaveResponse = NamingConventionWriteResponse.extend({
  createdValues: z.array(z.object({ dimension: z.string(), code: z.string(), label: z.string() })),
});
export type NamingConventionSaveResponse = z.infer<typeof NamingConventionSaveResponse>;

/** POST /workspaces/:ws/naming-convention/aliases: one click "map to…" — the token of that dimension's position reads as `value`. */
export const AddNamingAliasInput = z
  .object({ dimension: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), token: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(200) })
  .strict();
export type AddNamingAliasInput = z.infer<typeof AddNamingAliasInput>;

/** The AI's answer (validated before anyone sees it). Positions are 1-based. Nothing is applied. */
export const NamingAiSuggestion = z
  .object({
    delimiter: NamingConventionDelimiter,
    positions: z.array(z.object({ dimension: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).nullable(), confidence: z.number().min(0).max(1) }).strict()).min(1).max(20),
    mappings: z.array(z.object({ position: z.number().int().min(1).max(20), token: z.string().min(1).max(100), value: z.string().min(1).max(200), confidence: z.number().min(0).max(1) }).strict()).max(500).default([]),
  })
  .strict();
export type NamingAiSuggestion = z.infer<typeof NamingAiSuggestion>;

/** At most this many distinct campaign names go to the model. */
export const MAX_AI_NAMES = 300;

export const SuggestNamingInput = z.object({ names: z.array(z.string().min(1).max(500)).max(MAX_AI_NAMES).optional() }).strict();
export type SuggestNamingInput = z.infer<typeof SuggestNamingInput>;

export const SuggestNamingResponse = z.object({
  suggestion: NamingAiSuggestion,
  /** The suggestion as a convention to review: positions → dimensions, mappings → aliases. */
  proposal: ConventionProposal,
  model: z.string(),
  names: z.number().int(),
  applied: z.literal(false),
});
export type SuggestNamingResponse = z.infer<typeof SuggestNamingResponse>;

/** The suggestion as a convention: each position's dimension; its mappings (confidence ≥ 0.5) as aliases, except tokens that already read as that value. */
export function proposalFromSuggestion(s: NamingAiSuggestion, resolve?: TokenResolver): ConventionProposal {
  return {
    delimiter: s.delimiter,
    tokens: s.positions.map((p, i) => {
      if (p.dimension === null) return { dimension: null, aliases: {} };
      const dim = p.dimension;
      const aliases = Object.fromEntries(
        s.mappings.filter((m) => m.position === i + 1 && m.confidence >= 0.5 && resolve?.(dim, m.token)?.code !== m.value).map((m) => [m.token, m.value] as const),
      );
      return { dimension: dim, aliases };
    }),
  };
}

/** Narrow a proposal to what POST/PUT accept (at least one named position) or null. */
export function proposalAsInput(p: ConventionProposal): CreateNamingConventionInput | null {
  return p.tokens.some((t) => t.dimension !== null) ? { delimiter: p.delimiter, tokens: p.tokens } : null;
}
