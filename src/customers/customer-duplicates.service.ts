import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Customer } from '../database/entities/customer.entity';

export type DuplicateReason = 'email' | 'phone' | 'name';

export interface DuplicatePair {
  a: Customer;
  b: Customer;
  reasons: DuplicateReason[];
  // 1 for an identical email/phone, otherwise the name similarity (0-1)
  score: number;
}

export interface DuplicateCandidate {
  customer: Customer;
  reasons: DuplicateReason[];
}

export interface DuplicateCheckInput {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  excludeId?: string;
}

// Names at least this similar (pg_trgm similarity) count as likely duplicates
export const NAME_SIMILARITY_THRESHOLD = 0.6;
// Phone numbers need this many digits to be compared
export const MIN_PHONE_DIGITS = 7;
// Phones are compared on their last digits, so "+1 555 010 0000" matches "555-010-0000"
// and "+33 6 12 34 56 78" matches "06 12 34 56 78"
export const PHONE_MATCH_DIGITS = 9;

// Same expressions as the migration's indexes, so they can be used
const EMAIL = (t: string) => `lower(btrim(${t}."email"))`;
const DIGITS = (t: string) => `regexp_replace(${t}."phone", '[^0-9]', '', 'g')`;
const PHONE = (t: string) => `right(${DIGITS(t)}, ${PHONE_MATCH_DIGITS})`;
const NAME = (t: string) =>
  `lower(btrim(coalesce(${t}."firstName", '') || ' ' || coalesce(${t}."lastName", '')))`;

export const normalizeEmail = (value?: string | null) =>
  value?.trim().toLowerCase() || null;
export const normalizePhone = (value?: string | null) => {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= MIN_PHONE_DIGITS
    ? digits.slice(-PHONE_MATCH_DIGITS)
    : null;
};
export const normalizeName = (first?: string | null, last?: string | null) => {
  const name = `${first ?? ''} ${last ?? ''}`.trim().toLowerCase();
  return name.length >= 3 ? name : null;
};

/**
 * Likely duplicate customers: same normalised email or phone, or a very similar
 * name (pg_trgm trigram similarity when the extension is installed, otherwise
 * an exact normalised-name match). Merged records are ignored.
 */
@Injectable()
export class CustomerDuplicatesService {
  private trigram?: boolean;

  constructor(private dataSource: DataSource) {}

  async hasTrigram(): Promise<boolean> {
    if (this.trigram === undefined) {
      const rows = await this.dataSource.query<unknown[]>(
        `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      this.trigram = rows.length > 0;
    }
    return this.trigram;
  }

  async findPairs(tenantId: string, limit = 50): Promise<DuplicatePair[]> {
    const trigram = await this.hasTrigram();
    const nameMatch = trigram
      ? `${NAME('a')} % ${NAME('b')}`
      : `${NAME('a')} = ${NAME('b')}`;
    const nameScore = trigram ? `similarity(${NAME('a')}, ${NAME('b')})` : '1';
    const pairsFrom = (
      condition: string,
      reason: DuplicateReason,
      score: string,
    ) => `
      SELECT a.id AS "aId", b.id AS "bId", '${reason}' AS reason, ${score}::float AS score
      FROM customers a
      JOIN customers b ON b."tenantId" = a."tenantId" AND a.id < b.id AND ${condition}
      WHERE a."tenantId" = $1 AND a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL`;

    const rows = await this.withThreshold(trigram, (manager) =>
      manager.query<
        {
          aId: string;
          bId: string;
          reasons: DuplicateReason[];
          score: number;
        }[]
      >(
        `SELECT "aId", "bId", array_agg(DISTINCT reason) AS reasons, max(score) AS score
         FROM (
           ${pairsFrom(`${EMAIL('a')} = ${EMAIL('b')} AND ${EMAIL('a')} <> ''`, 'email', '1')}
           UNION ALL
           ${pairsFrom(
             `${PHONE('a')} = ${PHONE('b')} AND length(${DIGITS('a')}) >= ${MIN_PHONE_DIGITS}`,
             'phone',
             '1',
           )}
           UNION ALL
           ${pairsFrom(`length(${NAME('a')}) >= 3 AND ${nameMatch}`, 'name', nameScore)}
         ) matches
         GROUP BY "aId", "bId"
         ORDER BY count(*) DESC, max(score) DESC, "aId", "bId"
         LIMIT $2`,
        [tenantId, limit],
      ),
    );
    if (rows.length === 0) return [];

    const ids = [...new Set(rows.flatMap((r) => [r.aId, r.bId]))];
    const customers = await this.dataSource.getRepository(Customer).find({
      where: { tenantId, id: In(ids) },
      relations: { group: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return rows
      .filter((r) => byId.has(r.aId) && byId.has(r.bId))
      .map((r) => ({
        a: byId.get(r.aId)!,
        b: byId.get(r.bId)!,
        reasons: r.reasons,
        score: Math.round(Number(r.score) * 100) / 100,
      }));
  }

  /** Existing customers that look like the given details (warning when creating one) */
  async findMatches(
    tenantId: string,
    input: DuplicateCheckInput,
    limit = 5,
  ): Promise<DuplicateCandidate[]> {
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const name = normalizeName(input.firstName, input.lastName);
    if (!email && !phone && !name) return [];

    const trigram = await this.hasTrigram();
    const c = 'customer';
    const params: unknown[] = [
      tenantId,
      email,
      phone,
      name,
      input.excludeId ?? null,
      limit,
    ];
    const nameMatch = trigram ? `${NAME(c)} % $4` : `${NAME(c)} = $4`;
    const rows = await this.withThreshold(trigram, (manager) =>
      manager.query<
        { id: string; email: boolean; phone: boolean; name: boolean }[]
      >(
        `SELECT id,
           ($2::text IS NOT NULL AND ${EMAIL(c)} = $2) AS email,
           ($3::text IS NOT NULL AND length(${DIGITS(c)}) >= ${MIN_PHONE_DIGITS} AND ${PHONE(c)} = $3) AS phone,
           ($4::text IS NOT NULL AND ${nameMatch}) AS name
         FROM customers ${c}
         WHERE ${c}."tenantId" = $1 AND ${c}."mergedIntoId" IS NULL
           AND ($5::uuid IS NULL OR ${c}.id <> $5)
           AND (($2::text IS NOT NULL AND ${EMAIL(c)} = $2)
             OR ($3::text IS NOT NULL AND length(${DIGITS(c)}) >= ${MIN_PHONE_DIGITS} AND ${PHONE(c)} = $3)
             OR ($4::text IS NOT NULL AND ${nameMatch}))
         LIMIT $6`,
        params,
      ),
    );
    if (rows.length === 0) return [];
    const customers = await this.dataSource.getRepository(Customer).find({
      where: { tenantId, id: In(rows.map((r) => r.id)) },
    });
    const byId = new Map(customers.map((cu) => [cu.id, cu]));
    return rows
      .filter((r) => byId.has(r.id))
      .map((r) => ({
        customer: byId.get(r.id)!,
        reasons: (['email', 'phone', 'name'] as const).filter((k) => r[k]),
      }))
      .sort((x, y) => y.reasons.length - x.reasons.length);
  }

  // Run with a stricter trigram similarity threshold for this transaction only
  private withThreshold<T>(
    trigram: boolean,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      if (trigram) {
        await manager.query(
          `SELECT set_config('pg_trgm.similarity_threshold', $1, true)`,
          [String(NAME_SIMILARITY_THRESHOLD)],
        );
      }
      return work(manager);
    });
  }
}
