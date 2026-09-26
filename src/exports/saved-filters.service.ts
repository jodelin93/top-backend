import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { findReport } from '../reports/report-definitions';
import { SaveReportFilterDto } from './exports.dto';
import { returnedRows } from './export-logic';

interface SavedFilterRow {
  id: string;
  userId: string;
  reportKey: string;
  name: string;
  params: Record<string, unknown>;
  shared: boolean;
  created_at: Date;
  updated_at: Date;
  ownerName?: string | null;
}

const view = (row: SavedFilterRow, userId: string) => ({
  id: row.id,
  reportKey: row.reportKey,
  name: row.name,
  params: row.params,
  shared: row.shared,
  ownerName: row.ownerName ?? null,
  mine: row.userId === userId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const PARAM_KEYS = [
  'preset',
  'from',
  'to',
  'timezone',
  'branchId',
  'variantId',
  'locationId',
] as const;

/**
 * Saved report filters: named parameters a user re-applies in one click. Shared
 * ones are visible to everyone who can view reports (the controller requires
 * reports.view); only the owner can change or delete a filter.
 */
@Injectable()
export class SavedFiltersService {
  constructor(private dataSource: DataSource) {}

  async list(tenantId: string, userId: string, reportKey?: string) {
    const rows = await this.dataSource.query<SavedFilterRow[]>(
      `SELECT f.*, COALESCE(NULLIF(CONCAT_WS(' ', u."firstName", u."lastName"), ''), u.email) AS "ownerName"
         FROM saved_report_filters f JOIN users u ON u.id = f."userId"
        WHERE f."tenantId" = $1 AND (f."userId" = $2 OR f.shared)
          AND ($3::varchar IS NULL OR f."reportKey" = $3::varchar)
        ORDER BY f."reportKey", f.name`,
      [tenantId, userId, reportKey ?? null],
    );
    return rows.map((row) => view(row, userId));
  }

  async create(tenantId: string, userId: string, dto: SaveReportFilterDto) {
    this.assertReport(dto.reportKey);
    try {
      const rows = await this.dataSource.query<SavedFilterRow[]>(
        `INSERT INTO saved_report_filters ("tenantId", "userId", "reportKey", name, params, shared)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          tenantId,
          userId,
          dto.reportKey,
          dto.name.trim(),
          JSON.stringify(this.params(dto.params)),
          dto.shared ?? false,
        ],
      );
      return view(returnedRows<SavedFilterRow>(rows)[0], userId);
    } catch (error) {
      throw this.duplicate(error);
    }
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: SaveReportFilterDto,
  ) {
    this.assertReport(dto.reportKey);
    try {
      const result: unknown = await this.dataSource.query(
        `UPDATE saved_report_filters
            SET "reportKey" = $4, name = $5, params = $6, shared = $7, updated_at = now()
          WHERE id = $1 AND "tenantId" = $2 AND "userId" = $3
          RETURNING *`,
        [
          id,
          tenantId,
          userId,
          dto.reportKey,
          dto.name.trim(),
          JSON.stringify(this.params(dto.params)),
          dto.shared ?? false,
        ],
      );
      const [row] = returnedRows<SavedFilterRow>(result);
      if (!row) throw new NotFoundException('Saved filter not found');
      return view(row, userId);
    } catch (error) {
      throw this.duplicate(error);
    }
  }

  /** Only the owner deletes a filter (shared or not) */
  async remove(tenantId: string, userId: string, id: string) {
    const result: unknown = await this.dataSource.query(
      `DELETE FROM saved_report_filters WHERE id = $1 AND "tenantId" = $2 AND "userId" = $3 RETURNING id`,
      [id, tenantId, userId],
    );
    if (returnedRows(result).length === 0) {
      throw new NotFoundException('Saved filter not found');
    }
  }

  private assertReport(key: string) {
    if (!findReport(key)) throw new NotFoundException(`Unknown report: ${key}`);
  }

  // Only known parameters are kept
  private params(params: object) {
    const source = params as Record<string, unknown>;
    return Object.fromEntries(
      PARAM_KEYS.filter(
        (k) => source[k] !== undefined && source[k] !== null,
      ).map((k) => [k, source[k]]),
    );
  }

  private duplicate(error: unknown) {
    if ((error as { code?: string })?.code === '23505') {
      return new ConflictException('You already have a filter with this name');
    }
    return error;
  }
}
