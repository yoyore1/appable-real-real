import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { getDb } from "@appable/db";

const GUEST_DOMAIN = "guest.appable.dev";

export function isGuestEmail(email: string): boolean {
  return email.endsWith(`@${GUEST_DOMAIN}`);
}

export interface AuthUser {
  userId: string;
  email: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>("/auth/register", async (req, reply) => {
    const { email, password } = req.body ?? {};
    if (!email || !password || password.length < 6) {
      return reply.code(400).send({ error: "Email and a password of 6+ characters required" });
    }
    const db = getDb();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "Email already registered" });
    }
    const user = await db.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
    });
    const token = app.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  });

  app.post<{
    Body: { email: string; password: string; guestToken?: string; transferProjectId?: string };
  }>("/auth/login", async (req, reply) => {
    const { email, password, guestToken, transferProjectId } = req.body ?? {};
    const db = getDb();
    const user = email ? await db.user.findUnique({ where: { email } }) : null;
    if (!user || !(await bcrypt.compare(password ?? "", user.passwordHash))) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }

    // If the user did the interview as a guest then logged into an existing
    // account, move the guest's project over to the real account.
    if (guestToken && transferProjectId) {
      try {
        const guest = app.jwt.verify<AuthUser>(guestToken);
        if (isGuestEmail(guest.email)) {
          await db.project.updateMany({
            where: { id: transferProjectId, userId: guest.userId },
            data: { userId: user.id },
          });
        }
      } catch {
        // invalid guest token - skip transfer silently
      }
    }

    const token = app.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  });

  /** Anonymous session so normies can start the interview before signing up. */
  app.post("/auth/guest", async () => {
    const db = getDb();
    const email = `guest-${randomUUID()}@${GUEST_DOMAIN}`;
    const user = await db.user.create({
      data: { email, passwordHash: await bcrypt.hash(randomUUID(), 4) },
    });
    const token = app.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email }, guest: true };
  });

  /** Turn the current guest session into a real account (sign-up after interview). */
  app.post<{ Body: { email: string; password: string } }>("/auth/claim", async (req, reply) => {
    await req.jwtVerify();
    const { email, password } = req.body ?? {};
    if (!email || !email.includes("@") || !password || password.length < 6) {
      return reply.code(400).send({ error: "Email and a password of 6+ characters required" });
    }
    const db = getDb();
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "That email already has an account - log in instead" });
    }
    const user = await db.user.update({
      where: { id: req.user.userId },
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
    });
    const token = app.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  });
}

/** Fastify preHandler that requires a valid JWT. */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  await req.jwtVerify();
}
