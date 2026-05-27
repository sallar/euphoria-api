import { sql } from "drizzle-orm";

import type {
  profileGenderValues,
  profileOrientationValues,
  profileRelationshipTypeValues,
  profileTypeValues,
} from "@/db/profile-schema";

import { profile } from "@/db/profile-schema";
import { db } from "@/lib/db";

type ProfileSeed = typeof profile.$inferInsert;
type ProfileType = (typeof profileTypeValues)[number];
type ProfileGender = (typeof profileGenderValues)[number];
type ProfileOrientation = (typeof profileOrientationValues)[number];
type ProfileRelationshipType = (typeof profileRelationshipTypeValues)[number];
type PrimaryGender = Extract<ProfileGender, "man" | "woman" | "non_binary" | "intersex" | "custom">;

type ProfileConfig = {
  profileType: ProfileType;
  gender: PrimaryGender;
  genderTags: ProfileGender[];
  genderInterests: ProfileGender[];
  orientation: ProfileOrientation;
  orientationInterests: ProfileOrientation[];
  relationshipTypes: ProfileRelationshipType[];
};

type Neighborhood = {
  city: "Espoo" | "Helsinki";
  name: string;
  x: number;
  y: number;
};

const seedProfileCount = 10_000;
const insertBatchSize = 500;
const dayMs = 24 * 60 * 60 * 1000;

const neighborhoods: Neighborhood[] = [
  { city: "Helsinki", name: "Kallio", x: 24.949, y: 60.184 },
  { city: "Helsinki", name: "Punavuori", x: 24.936, y: 60.161 },
  { city: "Helsinki", name: "Kamppi", x: 24.933, y: 60.169 },
  { city: "Helsinki", name: "Toolo", x: 24.925, y: 60.177 },
  { city: "Helsinki", name: "Hakaniemi", x: 24.952, y: 60.179 },
  { city: "Helsinki", name: "Kruununhaka", x: 24.956, y: 60.172 },
  { city: "Helsinki", name: "Katajanokka", x: 24.969, y: 60.167 },
  { city: "Helsinki", name: "Vallila", x: 24.956, y: 60.194 },
  { city: "Helsinki", name: "Pasila", x: 24.934, y: 60.199 },
  { city: "Helsinki", name: "Lauttasaari", x: 24.877, y: 60.158 },
  { city: "Helsinki", name: "Ruoholahti", x: 24.915, y: 60.163 },
  { city: "Helsinki", name: "Jatkasaari", x: 24.915, y: 60.156 },
  { city: "Helsinki", name: "Herttoniemi", x: 25.033, y: 60.195 },
  { city: "Helsinki", name: "Kulosaari", x: 25.006, y: 60.184 },
  { city: "Helsinki", name: "Munkkiniemi", x: 24.879, y: 60.198 },
  { city: "Helsinki", name: "Kalasatama", x: 24.98, y: 60.188 },
  { city: "Helsinki", name: "Sornainen", x: 24.96, y: 60.187 },
  { city: "Helsinki", name: "Arabia", x: 24.976, y: 60.209 },
  { city: "Helsinki", name: "Oulunkyla", x: 24.968, y: 60.229 },
  { city: "Helsinki", name: "Viikki", x: 25.02, y: 60.225 },
  { city: "Helsinki", name: "Eira", x: 24.94, y: 60.157 },
  { city: "Helsinki", name: "Ullanlinna", x: 24.947, y: 60.161 },
  { city: "Helsinki", name: "Kaartinkaupunki", x: 24.948, y: 60.166 },
  { city: "Helsinki", name: "Etu-Toolo", x: 24.928, y: 60.174 },
  { city: "Helsinki", name: "Meilahti", x: 24.907, y: 60.19 },
  { city: "Helsinki", name: "Haaga", x: 24.893, y: 60.218 },
  { city: "Helsinki", name: "Pitajanmaki", x: 24.857, y: 60.223 },
  { city: "Helsinki", name: "Maunula", x: 24.927, y: 60.229 },
  { city: "Helsinki", name: "Pakila", x: 24.947, y: 60.248 },
  { city: "Helsinki", name: "Malmi", x: 25.013, y: 60.251 },
  { city: "Helsinki", name: "Tapanila", x: 25.027, y: 60.263 },
  { city: "Helsinki", name: "Pukinmaki", x: 24.994, y: 60.243 },
  { city: "Helsinki", name: "Kontula", x: 25.081, y: 60.238 },
  { city: "Helsinki", name: "Myllypuro", x: 25.077, y: 60.222 },
  { city: "Helsinki", name: "Itakeskus", x: 25.082, y: 60.212 },
  { city: "Helsinki", name: "Vuosaari", x: 25.142, y: 60.209 },
  { city: "Helsinki", name: "Laajasalo", x: 25.044, y: 60.17 },
  { city: "Helsinki", name: "Roihuvuori", x: 25.058, y: 60.201 },
  { city: "Helsinki", name: "Pihlajamaki", x: 25.009, y: 60.235 },
  { city: "Helsinki", name: "Konala", x: 24.843, y: 60.236 },
  { city: "Espoo", name: "Tapiola", x: 24.807, y: 60.176 },
  { city: "Espoo", name: "Otaniemi", x: 24.827, y: 60.185 },
  { city: "Espoo", name: "Keilaniemi", x: 24.832, y: 60.171 },
  { city: "Espoo", name: "Leppavaara", x: 24.813, y: 60.218 },
  { city: "Espoo", name: "Matinkyla", x: 24.738, y: 60.158 },
  { city: "Espoo", name: "Niittykumpu", x: 24.766, y: 60.171 },
  { city: "Espoo", name: "Olari", x: 24.744, y: 60.174 },
  { city: "Espoo", name: "Haukilahti", x: 24.768, y: 60.151 },
  { city: "Espoo", name: "Westend", x: 24.797, y: 60.162 },
  { city: "Espoo", name: "Mankkaa", x: 24.77, y: 60.197 },
  { city: "Espoo", name: "Laajalahti", x: 24.798, y: 60.196 },
  { city: "Espoo", name: "Kilo", x: 24.78, y: 60.218 },
  { city: "Espoo", name: "Karakallio", x: 24.752, y: 60.225 },
  { city: "Espoo", name: "Suurpelto", x: 24.759, y: 60.187 },
  { city: "Espoo", name: "Espoon keskus", x: 24.657, y: 60.205 },
  { city: "Espoo", name: "Kauklahti", x: 24.603, y: 60.189 },
  { city: "Espoo", name: "Espoonlahti", x: 24.67, y: 60.148 },
  { city: "Espoo", name: "Kivenlahti", x: 24.64, y: 60.133 },
  { city: "Espoo", name: "Soukka", x: 24.672, y: 60.137 },
  { city: "Espoo", name: "Nokkala", x: 24.725, y: 60.142 },
  { city: "Espoo", name: "Lippajarvi", x: 24.729, y: 60.236 },
  { city: "Espoo", name: "Viherlaakso", x: 24.745, y: 60.227 },
  { city: "Espoo", name: "Laaksolahti", x: 24.693, y: 60.252 },
  { city: "Espoo", name: "Nuuksio", x: 24.5, y: 60.31 },
];

const soloNames = [
  "Aino",
  "Elias",
  "Mira",
  "Onni",
  "Sofia",
  "Noel",
  "Emilia",
  "Leo",
  "Veera",
  "Mikael",
  "Sara",
  "Eero",
  "Iiris",
  "Oliver",
  "Lumi",
  "Niko",
  "Ada",
  "Rasmus",
  "Helmi",
  "Joel",
  "Ella",
  "Anton",
  "Venla",
  "Minea",
  "Linnea",
  "Aada",
  "Samu",
  "Kira",
  "Matias",
  "Nora",
  "Vilma",
  "Topias",
  "Alina",
  "Oskari",
  "Maija",
  "Joonas",
  "Silja",
  "Tuomas",
  "Reetta",
  "Kasper",
  "Inka",
  "Aleksi",
  "Roni",
  "Tiia",
  "Jasmin",
  "Petra",
  "Milo",
  "Sanni",
  "Kalle",
  "Anni",
];

const coupleNames = [
  "Aino & Leo",
  "Mira & Sofia",
  "Elias & Noel",
  "Veera & Sara",
  "Niko & Oliver",
  "Lumi & Helmi",
  "Ada & Linnea",
  "Joel & Anton",
  "Nora & Vilma",
  "Iiris & Ella",
];

const groupNames = [
  "Kallio Date Club",
  "Kamppi Dinner Circle",
  "Helsinki Board Game Crew",
  "Sunday Sauna Friends",
  "Afterwork Vinyl Night",
  "Kalasatama Supper Group",
  "Punavuori Poly Pod",
  "Hakaniemi Brunch Table",
];

const openingLines = [
  "Coffee, gallery walks, and slow Sunday mornings.",
  "Happiest near the sea, a good playlist, and a tiny dance floor.",
  "Looking for clear communication, warmth, and a little mischief.",
  "Into cooking, long walks, and people who ask good questions.",
  "Low-pressure dates, excellent snacks, and honest intentions.",
  "Usually planning the next museum visit or sauna evening.",
  "Here for chemistry, curiosity, and kind people.",
  "Likes urban exploring, dinner parties, and late summer light.",
  "Enjoys climbing, natural wine, and direct communication.",
  "Can be won over with ramen, records, or a thoughtful plan.",
];

const dateIdeas = [
  "a walk around Tokoinranta",
  "coffee near the market hall",
  "a ferry ride and picnic",
  "dumplings after work",
  "a tiny gig in Kallio",
  "a bookstore browse",
  "ice cream by the harbor",
  "a museum and a glass of wine",
  "a board game cafe night",
  "a sauna and swim",
];

const profileConfigs: ProfileConfig[] = [
  {
    profileType: "solo",
    gender: "woman",
    genderTags: ["cis_woman"],
    genderInterests: ["man", "woman", "non_binary"],
    orientation: "bisexual",
    orientationInterests: ["bisexual", "pansexual", "queer"],
    relationshipTypes: ["dating", "long_term", "monogamish"],
  },
  {
    profileType: "solo",
    gender: "man",
    genderTags: ["cis_man"],
    genderInterests: ["woman", "non_binary"],
    orientation: "heteroflexible",
    orientationInterests: ["heterosexual", "bisexual", "queer"],
    relationshipTypes: ["dating", "serious", "long_term"],
  },
  {
    profileType: "solo",
    gender: "non_binary",
    genderTags: ["enby", "genderqueer"],
    genderInterests: ["woman", "man", "non_binary", "trans_woman", "trans_man"],
    orientation: "queer",
    orientationInterests: ["queer", "pansexual", "bisexual"],
    relationshipTypes: ["ethical_non_monogamy", "relationship_anarchy", "friendship"],
  },
  {
    profileType: "solo",
    gender: "woman",
    genderTags: ["trans_woman"],
    genderInterests: ["woman", "non_binary", "trans_woman"],
    orientation: "lesbian",
    orientationInterests: ["lesbian", "queer", "homoflexible"],
    relationshipTypes: ["dating", "long_term", "monogamous"],
  },
  {
    profileType: "solo",
    gender: "man",
    genderTags: ["trans_man", "transmasculine"],
    genderInterests: ["man", "non_binary", "trans_man"],
    orientation: "gay",
    orientationInterests: ["gay", "homoflexible", "queer"],
    relationshipTypes: ["casual", "dating", "friends_with_benefits"],
  },
  {
    profileType: "solo",
    gender: "woman",
    genderTags: ["cis_woman"],
    genderInterests: ["man"],
    orientation: "heterosexual",
    orientationInterests: ["heterosexual", "heteroflexible"],
    relationshipTypes: ["monogamous", "serious", "long_term"],
  },
  {
    profileType: "solo",
    gender: "man",
    genderTags: ["cis_man"],
    genderInterests: ["man"],
    orientation: "homosexual",
    orientationInterests: ["gay", "homosexual", "queer"],
    relationshipTypes: ["dating", "long_term", "one_on_one_only"],
  },
  {
    profileType: "solo",
    gender: "non_binary",
    genderTags: ["agender"],
    genderInterests: ["non_binary", "woman"],
    orientation: "asexual",
    orientationInterests: ["asexual", "demisexual", "graysexual"],
    relationshipTypes: ["platonic", "queerplatonic", "friendship"],
  },
  {
    profileType: "solo",
    gender: "woman",
    genderTags: ["genderfluid"],
    genderInterests: ["man", "woman", "non_binary"],
    orientation: "pansexual",
    orientationInterests: ["pansexual", "omnisexual", "queer"],
    relationshipTypes: ["polyamorous", "kitchen_table_poly", "non_hierarchical"],
  },
  {
    profileType: "solo",
    gender: "man",
    genderTags: ["androgynous"],
    genderInterests: ["woman", "non_binary"],
    orientation: "demisexual",
    orientationInterests: ["demisexual", "graysexual", "bisexual"],
    relationshipTypes: ["dating", "friendship", "long_term"],
  },
  {
    profileType: "couple",
    gender: "custom",
    genderTags: ["woman", "man"],
    genderInterests: ["woman", "non_binary"],
    orientation: "bisexual",
    orientationInterests: ["bisexual", "pansexual", "queer"],
    relationshipTypes: ["couple", "open_relationship", "casual"],
  },
  {
    profileType: "couple",
    gender: "custom",
    genderTags: ["woman", "non_binary"],
    genderInterests: ["man", "woman", "non_binary"],
    orientation: "queer",
    orientationInterests: ["queer", "pansexual", "bisexual"],
    relationshipTypes: ["ethical_non_monogamy", "play_partner", "friends_with_benefits"],
  },
  {
    profileType: "group",
    gender: "custom",
    genderTags: ["woman", "man", "non_binary"],
    genderInterests: ["woman", "man", "non_binary"],
    orientation: "queer",
    orientationInterests: ["queer", "pansexual", "bisexual", "omnisexual"],
    relationshipTypes: ["group", "friendship", "casual_play"],
  },
  {
    profileType: "solo",
    gender: "intersex",
    genderTags: ["intersex", "gender_nonconforming"],
    genderInterests: ["woman", "man", "non_binary", "intersex"],
    orientation: "omnisexual",
    orientationInterests: ["omnisexual", "pansexual", "queer"],
    relationshipTypes: ["dating", "ethical_non_monogamy", "long_term"],
  },
  {
    profileType: "solo",
    gender: "custom",
    genderTags: ["maverique", "gender_variant"],
    genderInterests: ["non_binary", "custom", "woman"],
    orientation: "grayromantic",
    orientationInterests: ["grayromantic", "demiromantic", "aromantic"],
    relationshipTypes: ["queerplatonic", "platonic", "friendship"],
  },
];

const pick = <T>(values: T[], index: number): T => values[index % values.length];

const pad = (value: number) => value.toString().padStart(2, "0");

const seedProfileId = (index: number) =>
  `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;

const locationNear = (neighborhood: Neighborhood, index: number) => ({
  x: Number((neighborhood.x + Math.cos(index * 1.7) * 0.006).toFixed(6)),
  y: Number((neighborhood.y + Math.sin(index * 1.3) * 0.0035).toFixed(6)),
});

const dateOfBirthFor = (index: number) => {
  const age = 20 + ((index * 7) % 38);
  const year = 2026 - age;
  const month = (index % 12) + 1;
  const day = ((index * 3) % 28) + 1;

  return `${year}-${pad(month)}-${pad(day)}`;
};

const profileNameFor = (config: ProfileConfig, index: number) => {
  if (config.profileType === "couple") return `${pick(coupleNames, index)}`;
  if (config.profileType === "group") return `${pick(groupNames, index)}`;

  return `${pick(soloNames, index)}`;
};

const relationshipSummary = (relationshipTypes: ProfileRelationshipType[]) =>
  relationshipTypes.map((type) => type.replaceAll("_", " ")).join(", ");

const profileBioFor = (config: ProfileConfig, neighborhood: Neighborhood, index: number) =>
  [
    `Seed profile in ${neighborhood.name}, ${neighborhood.city}.`,
    pick(openingLines, index),
    `Ideal first date: ${pick(dateIdeas, index)}.`,
    `Open to ${relationshipSummary(config.relationshipTypes)}.`,
  ].join(" ");

const createSeedProfiles = () => {
  const now = new Date();

  return Array.from({ length: seedProfileCount }, (_, index): ProfileSeed => {
    const config = pick(profileConfigs, index);
    const neighborhood = pick(neighborhoods, index);
    const lastSeenAt = new Date(now.getTime() - ((index * 7) % 240) * 60 * 60 * 1000);
    const createdAt = new Date(now.getTime() - (30 + index) * dayMs);

    return {
      id: seedProfileId(index),
      createdAt,
      updatedAt: now,
      deletedAt: null,
      lastSeenAt,
      profileType: config.profileType,
      name: profileNameFor(config, index),
      bio: profileBioFor(config, neighborhood, index),
      gender: config.gender,
      genderTags: config.genderTags,
      genderInterests: config.genderInterests,
      orientation: config.orientation,
      orientationInterests: config.orientationInterests,
      relationshipTypes: config.relationshipTypes,
      location: locationNear(neighborhood, index),
      country: "FI",
      dateOfBirth: dateOfBirthFor(index),
      hidden: index % 13 === 0,
    };
  });
};

const main = async () => {
  const profiles = createSeedProfiles();

  let seededCount = 0;

  for (let index = 0; index < profiles.length; index += insertBatchSize) {
    const batch = profiles.slice(index, index + insertBatchSize);
    const seeded = await db
      .insert(profile)
      .values(batch)
      .onConflictDoUpdate({
        target: profile.id,
        set: {
          createdAt: sql`excluded.created_at`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          profileType: sql`excluded.profile_type`,
          name: sql`excluded.name`,
          bio: sql`excluded.bio`,
          gender: sql`excluded.gender`,
          genderTags: sql`excluded.gender_tags`,
          genderInterests: sql`excluded.gender_interests`,
          orientation: sql`excluded.orientation`,
          orientationInterests: sql`excluded.orientation_interests`,
          relationshipTypes: sql`excluded.relationship_types`,
          location: sql`excluded.location`,
          country: sql`excluded.country`,
          dateOfBirth: sql`excluded.date_of_birth`,
          hidden: sql`excluded.hidden`,
        },
      })
      .returning({ id: profile.id });

    seededCount += seeded.length;
  }

  const hiddenCount = profiles.filter((seed) => seed.hidden).length;

  console.log(`Seeded ${seededCount} Helsinki and Espoo profiles.`);
  console.log(`Visible profiles: ${profiles.length - hiddenCount}`);
  console.log(`Hidden profiles: ${hiddenCount}`);
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("Failed to seed Helsinki profiles");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
