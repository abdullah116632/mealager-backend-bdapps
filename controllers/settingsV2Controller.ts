import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";

import {
  consumersTable,
  db,
  messesTable,
  usersTable,
} from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";

// v2 admin-management endpoints. Being signed in as an admin of the mess is
// the only identity check; no password, Google or OTP confirmation is asked.

// GET /api/v2/settings/security/admins?messId=X — lists every current admin
// of the mess (primary admin and any co-admins), for the "View All Admins"
// screen. Open to any admin.
export const getMessAdminsV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId, mess } = access;

  const admins = await db
    .select({
      id: consumersTable.id,
      name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      userId: consumersTable.userId,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(
      and(
        eq(consumersTable.messId, messId),
        eq(consumersTable.isAdmin, true),
      ),
    );

  res.json({
    admins: admins.map((admin) => ({
      ...admin,
      isPrimaryAdmin: admin.userId === mess.adminUserId,
    })),
  });
};

// GET /api/v2/settings/security/eligible-admins?messId=X — same listing as
// the v1 endpoint, but open to any admin (primary or co-admin), not just
// the primary admin.
export const getEligibleAdminsV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const access = await resolveMessAccess(userId, req.query.messId, {
    adminOnly: true,
    missingMessIdError: "messId query param is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumers = await db
    .select({
      id: consumersTable.id,
      name: sql<string>`coalesce(${usersTable.name}, ${consumersTable.name})`,
      userId: consumersTable.userId,
      isAdmin: consumersTable.isAdmin,
      email: usersTable.email,
    })
    .from(consumersTable)
    .leftJoin(usersTable, eq(consumersTable.userId, usersTable.id))
    .where(eq(consumersTable.messId, messId));

  const eligible = consumers.filter(
    (c) => c.userId !== null && c.userId !== userId,
  );
  res.json({ consumers: eligible });
};

// POST /api/v2/settings/security/add-co-admin — grants admin to a member,
// Any admin
// (primary or co-admin) may grant admin to another member.
export const addCoAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdParam, consumerId: consumerIdParam } =
    req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumerId = parsePositiveInteger(consumerIdParam);
  const [consumer] = consumerId
    ? await db
        .select()
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.id, consumerId),
            eq(consumersTable.messId, messId),
          ),
        )
        .limit(1)
    : [];
  if (!consumer || !consumer.userId) {
    res
      .status(400)
      .json({ error: "Selected member does not have a linked account" });
    return;
  }
  if (consumer.userId === userId) {
    res.status(400).json({ error: "You are already the admin" });
    return;
  }
  if (consumer.isAdmin) {
    res.status(400).json({ error: "This member is already an admin" });
    return;
  }

  await db
    .update(consumersTable)
    .set({ isAdmin: true })
    .where(eq(consumersTable.id, consumer.id));

  res.json({ message: "Admin privileges granted successfully" });
};

// POST /api/v2/settings/security/add-admin — hands the caller's own admin
// status to another member. Any admin (primary or co-admin) may call this, but it
// only ever swaps the CALLER's own status: if the caller is the primary
// admin, the mess's primary-admin slot (messesTable.adminUserId) moves to
// the target too; a co-admin has no such slot to move, so only the two
// consumers' isAdmin flags swap.
export const transferAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdParam, consumerId: consumerIdParam } =
    req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const consumerId = parsePositiveInteger(consumerIdParam);
  const [target] = consumerId
    ? await db
        .select()
        .from(consumersTable)
        .where(
          and(
            eq(consumersTable.id, consumerId),
            eq(consumersTable.messId, messId),
          ),
        )
        .limit(1)
    : [];
  if (!target || !target.userId) {
    res
      .status(400)
      .json({ error: "Selected member does not have a linked account" });
    return;
  }
  if (target.userId === userId) {
    res.status(400).json({ error: "You are already the admin" });
    return;
  }
  if (target.isAdmin) {
    res.status(400).json({ error: "This member is already an admin" });
    return;
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${messesTable.id} from ${messesTable} where ${messesTable.id} = ${messId} for update`,
    );

    const [mess] = await tx
      .select({ adminUserId: messesTable.adminUserId })
      .from(messesTable)
      .where(eq(messesTable.id, messId))
      .limit(1);
    if (!mess) {
      return { error: "Mess not found", status: 404 } as const;
    }
    const isPrimaryAdmin = mess.adminUserId === userId;

    const [callerConsumer] = await tx
      .select({ id: consumersTable.id, isAdmin: consumersTable.isAdmin })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      )
      .limit(1);
    if (!callerConsumer) {
      return {
        error: "Your linked consumer record could not be found",
        status: 409,
      } as const;
    }
    if (!isPrimaryAdmin && !callerConsumer.isAdmin) {
      return { error: "Admin access required", status: 403 } as const;
    }

    const [newAdmin] = await tx
      .select({
        id: consumersTable.id,
        userId: consumersTable.userId,
        isAdmin: consumersTable.isAdmin,
      })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.id, target.id),
          eq(consumersTable.messId, messId),
        ),
      )
      .limit(1);
    if (!newAdmin?.userId) {
      return {
        error: "Selected member no longer has a linked account",
        status: 400,
      } as const;
    }
    if (newAdmin.userId === userId) {
      return { error: "You are already the admin", status: 400 } as const;
    }
    if (newAdmin.isAdmin) {
      return {
        error: "This member is already an admin",
        status: 400,
      } as const;
    }

    await tx
      .update(consumersTable)
      .set({ isAdmin: true })
      .where(eq(consumersTable.id, newAdmin.id));
    if (isPrimaryAdmin) {
      await tx
        .update(messesTable)
        .set({ adminUserId: newAdmin.userId })
        .where(eq(messesTable.id, messId));
    }
    await tx
      .update(consumersTable)
      .set({ isAdmin: false })
      .where(eq(consumersTable.id, callerConsumer.id));

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json({ message: "Admin role transferred successfully" });
};

// POST /api/v2/settings/security/remove-self-admin — revokes the caller's
// own admin role. Any admin (primary or co-admin) may call this. A mess must always
// keep at least one admin: if the caller is the only admin, this is
// rejected; if the caller is the primary admin, another existing admin
// becomes the new primary admin.
export const removeSelfAdminV2 = async (req: AuthedRequest, res: Response) => {
  const userId = req.auth!.userId;
  const { messId: messIdParam } = req.body ?? {};

  const access = await resolveMessAccess(userId, messIdParam, {
    adminOnly: true,
    missingMessIdError: "messId is required",
  });
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }
  const { messId } = access;

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${messesTable.id} from ${messesTable} where ${messesTable.id} = ${messId} for update`,
    );

    const [mess] = await tx
      .select({ id: messesTable.id, adminUserId: messesTable.adminUserId })
      .from(messesTable)
      .where(eq(messesTable.id, messId))
      .limit(1);
    if (!mess) {
      return { error: "Mess not found", status: 404 } as const;
    }

    const [currentConsumer] = await tx
      .select({ id: consumersTable.id, isAdmin: consumersTable.isAdmin })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.userId, userId),
        ),
      )
      .limit(1);
    const isPrimaryAdmin = mess.adminUserId === userId;
    if (!isPrimaryAdmin && !currentConsumer?.isAdmin) {
      return {
        error: "You are no longer an admin of this mess",
        status: 403,
      } as const;
    }
    if (!currentConsumer) {
      return {
        error: "Your linked consumer record could not be found",
        status: 409,
      } as const;
    }

    const adminConsumers = await tx
      .select({ id: consumersTable.id, userId: consumersTable.userId })
      .from(consumersTable)
      .where(
        and(
          eq(consumersTable.messId, messId),
          eq(consumersTable.isAdmin, true),
        ),
      );
    const adminUserIds = new Set<number>([mess.adminUserId]);
    for (const consumer of adminConsumers) {
      if (consumer.userId) adminUserIds.add(consumer.userId);
    }
    if (adminUserIds.size <= 1) {
      return {
        error:
          "You are the only admin. Add another admin before removing your role.",
        status: 409,
      } as const;
    }

    if (isPrimaryAdmin) {
      const replacement = adminConsumers.find(
        (consumer) => consumer.userId && consumer.userId !== userId,
      );
      if (!replacement?.userId) {
        return {
          error:
            "Another active admin is required before you can remove your role.",
          status: 409,
        } as const;
      }
      await tx
        .update(messesTable)
        .set({ adminUserId: replacement.userId })
        .where(eq(messesTable.id, messId));
    }

    await tx
      .update(consumersTable)
      .set({ isAdmin: false })
      .where(eq(consumersTable.id, currentConsumer.id));

    return { ok: true } as const;
  });

  if ("error" in outcome) {
    res.status(outcome.status ?? 400).json({ error: outcome.error });
    return;
  }

  res.json({ message: "Your admin role was removed successfully" });
};
