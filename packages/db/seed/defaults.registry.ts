import { ISO_COUNTRIES } from "./iso-countries.js";

export interface RegistryValueSeed {
  readonly code: string;
  readonly label: string;
  readonly parentCode?: string;
}

export interface RegistryDimensionSeed {
  readonly key: string;
  readonly label: string;
  readonly dataType: "ENUM" | "TEXT" | "REFERENCE" | "DATE_BUCKET";
  readonly icon: string;
  readonly allowedParents: readonly string[];
  readonly isRequiredForLeaf: boolean;
  readonly sortOrder: number;
  readonly values: readonly RegistryValueSeed[];
}

export const DEFAULT_HIERARCHY = {
  name: "Default",
  path: ["client", "region", "country", "platform", "objective"],
  isDefault: true,
} as const;

function values(pairs: ReadonlyArray<readonly [string, string]>): RegistryValueSeed[] {
  return pairs.map(([code, label]) => ({ code, label }));
}

const specs: ReadonlyArray<Omit<RegistryDimensionSeed, "sortOrder">> = [
  {
    key: "client",
    label: "Client",
    dataType: "TEXT",
    icon: "lucide:briefcase",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "brand",
    label: "Brand",
    dataType: "TEXT",
    icon: "lucide:tag",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "business_unit",
    label: "Business unit",
    dataType: "TEXT",
    icon: "lucide:building",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "region",
    label: "Region",
    dataType: "ENUM",
    icon: "lucide:globe",
    allowedParents: ["client"],
    isRequiredForLeaf: false,
    values: values([
      ["AMER", "AMER"],
      ["LATAM", "LATAM"],
      ["EMEA", "EMEA"],
      ["APAC", "APAC"],
    ]),
  },
  {
    key: "country",
    label: "Country",
    dataType: "ENUM",
    icon: "lucide:flag",
    allowedParents: ["region"],
    isRequiredForLeaf: false,
    values: ISO_COUNTRIES.map((country) => ({
      code: country.code,
      label: country.label,
      parentCode: country.regionCode,
    })),
  },
  {
    key: "channel",
    label: "Channel",
    dataType: "ENUM",
    icon: "lucide:layers",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: values([
      ["paid_social", "Paid social"],
      ["paid_search", "Paid search"],
      ["programmatic", "Programmatic"],
      ["retail_media", "Retail media"],
      ["video", "Video"],
      ["affiliate", "Affiliate"],
      ["other", "Other"],
    ]),
  },
  {
    key: "platform",
    label: "Platform",
    dataType: "ENUM",
    icon: "lucide:plug",
    allowedParents: ["country", "channel"],
    isRequiredForLeaf: false,
    values: values([
      ["meta", "Meta"],
      ["google_ads", "Google Ads"],
      ["dv360", "DV360"],
      ["tiktok", "TikTok"],
      ["amazon", "Amazon"],
      ["pinterest", "Pinterest"],
      ["snapchat", "Snapchat"],
      ["linkedin", "LinkedIn"],
      ["x", "X"],
      ["microsoft_ads", "Microsoft Ads"],
      ["other", "Other"],
    ]),
  },
  {
    key: "account",
    label: "Account",
    dataType: "TEXT",
    icon: "lucide:user-circle",
    allowedParents: ["platform"],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "campaign",
    label: "Campaign",
    dataType: "TEXT",
    icon: "lucide:megaphone",
    allowedParents: ["account"],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "objective",
    label: "Objective",
    dataType: "ENUM",
    icon: "lucide:target",
    allowedParents: ["platform", "campaign"],
    isRequiredForLeaf: false,
    values: values([
      ["brand", "Brand"],
      ["non_brand", "Non-brand"],
      ["competitor", "Competitor"],
      ["awareness", "Awareness"],
      ["consideration", "Consideration"],
      ["conversion", "Conversion"],
      ["retention", "Retention"],
    ]),
  },
  {
    key: "funnel_stage",
    label: "Funnel stage",
    dataType: "ENUM",
    icon: "lucide:filter",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: values([
      ["upper", "Upper"],
      ["mid", "Mid"],
      ["lower", "Lower"],
    ]),
  },
  {
    key: "audience",
    label: "Audience",
    dataType: "ENUM",
    icon: "lucide:users",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: values([
      ["prospecting", "Prospecting"],
      ["retargeting", "Retargeting"],
      ["lookalike", "Lookalike"],
      ["crm", "CRM"],
      ["broad", "Broad"],
    ]),
  },
  {
    key: "product_line",
    label: "Product line",
    dataType: "TEXT",
    icon: "lucide:package",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: [],
  },
  {
    key: "creative_format",
    label: "Creative format",
    dataType: "ENUM",
    icon: "lucide:image",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: values([
      ["static", "Static"],
      ["video", "Video"],
      ["carousel", "Carousel"],
      ["collection", "Collection"],
      ["story", "Story"],
      ["search_text", "Search text"],
      ["shopping", "Shopping"],
    ]),
  },
  {
    key: "fiscal_period",
    label: "Fiscal period",
    dataType: "DATE_BUCKET",
    icon: "lucide:calendar",
    allowedParents: [],
    isRequiredForLeaf: false,
    values: [],
  },
];

export const DEFAULT_DIMENSIONS: readonly RegistryDimensionSeed[] = specs.map((spec, sortOrder) => ({
  ...spec,
  sortOrder,
}));
