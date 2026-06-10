import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

let prisma: PrismaClient | undefined;

/** Singleton Prisma client shared across the API process. */
export function getDb(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}
