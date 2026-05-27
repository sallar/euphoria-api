import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomInt } from "node:crypto";

import { profile, profilePhoto } from "@/db/profile-schema";
import { db } from "@/lib/db";

type PhotoSource = {
  key: string;
  blurhash: string;
};

type ProfilePhotoSeed = typeof profilePhoto.$inferInsert;
type PhotoDealer = () => PhotoSource[];

const photosPath = new URL("./photos.json", import.meta.url);
const objectBucket = "euphoria-demo";
const photosPerProfile = 4;
const connectionOnlyPosition = photosPerProfile - 1;
const insertBatchSize = 1_000;

const readPhotoSources = async () => {
  const photos = (await Bun.file(photosPath).json()) as PhotoSource[];

  if (photos.length < photosPerProfile) {
    throw new Error(`Expected at least ${photosPerProfile} photos in ${photosPath.pathname}`);
  }

  for (const [index, photo] of photos.entries()) {
    if (!photo.key || !photo.blurhash) {
      throw new Error(`Photo source at index ${index} must include key and blurhash`);
    }
  }

  return photos;
};

const shufflePhotos = (photos: PhotoSource[]) => {
  const shuffled = photos.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = randomInt(index + 1);
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex]!, shuffled[index]!];
  }

  return shuffled;
};

const createPhotoDealer = (photos: PhotoSource[]): PhotoDealer => {
  let deck = shufflePhotos(photos);
  let deckIndex = 0;
  let previousProfileKeys = new Set<string>();
  const canAvoidNeighborOverlap = photos.length >= photosPerProfile * 2;

  return () => {
    const selected: PhotoSource[] = [];
    const selectedKeys = new Set<string>();

    while (selected.length < photosPerProfile) {
      if (deckIndex >= deck.length) {
        const blockedKeys = new Set([...previousProfileKeys, ...selectedKeys]);
        const nextDeck = shufflePhotos(photos);

        deck = canAvoidNeighborOverlap
          ? [
              ...nextDeck.filter((photo) => !blockedKeys.has(photo.key)),
              ...nextDeck.filter((photo) => blockedKeys.has(photo.key)),
            ]
          : nextDeck;
        deckIndex = 0;
      }

      const photo = deck[deckIndex]!;
      deckIndex += 1;

      if (selectedKeys.has(photo.key)) {
        continue;
      }

      if (canAvoidNeighborOverlap && previousProfileKeys.has(photo.key)) {
        continue;
      }

      selected.push(photo);
      selectedKeys.add(photo.key);
    }

    previousProfileKeys = selectedKeys;

    return selected;
  };
};

const createProfilePhotoSeeds = (profileIds: string[], dealPhotos: PhotoDealer) =>
  profileIds.flatMap((profileId): ProfilePhotoSeed[] =>
    dealPhotos().map((photo, position) => ({
      profileId,
      objectBucket,
      objectKey: photo.key,
      hash: photo.blurhash,
      position,
      connectionOnly: position === connectionOnlyPosition,
    })),
  );

const main = async () => {
  const photos = await readPhotoSources();
  const dealPhotos = createPhotoDealer(photos);
  const profiles = await db
    .select({ id: profile.id })
    .from(profile)
    .where(isNull(profile.deletedAt));
  const profileIds = profiles.map(({ id }) => id);

  if (!profileIds.length) {
    console.log("No active profiles found. Seed profiles before seeding photos.");
    return;
  }

  let deletedCount = 0;
  let insertedCount = 0;

  for (let index = 0; index < profileIds.length; index += insertBatchSize) {
    const batchProfileIds = profileIds.slice(index, index + insertBatchSize);
    const deleted = await db
      .delete(profilePhoto)
      .where(
        and(
          inArray(profilePhoto.profileId, batchProfileIds),
          eq(profilePhoto.objectBucket, objectBucket),
        ),
      )
      .returning({ id: profilePhoto.id });
    const seeds = createProfilePhotoSeeds(batchProfileIds, dealPhotos);
    const inserted = await db.insert(profilePhoto).values(seeds).returning({ id: profilePhoto.id });

    deletedCount += deleted.length;
    insertedCount += inserted.length;
  }

  console.log(`Seeded ${insertedCount} profile photos for ${profileIds.length} profiles.`);
  console.log(`Connection-only photos: ${profileIds.length}`);
  console.log(`Deleted existing ${objectBucket} photos before reseeding: ${deletedCount}`);
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("Failed to seed profile photos");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
