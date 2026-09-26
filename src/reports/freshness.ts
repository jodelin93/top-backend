import { DataSource } from 'typeorm';

/**
 * How complete the figures are (spec §14): when they were computed and whether
 * tills still hold sales that haven't reached the server. Read-only look at the
 * devices' last reported counters (devices module), limited to the branches
 * of the report when it is filtered.
 */
export interface DataFreshness {
  generatedAt: string;
  // Sales waiting on tills to upload (the figures may be incomplete)
  pendingSales: number;
  // Sales a till failed to upload
  failedSales: number;
  devicesWithPendingSales: number;
  lastDeviceSyncAt: string | null;
  complete: boolean;
}

export async function dataFreshness(
  dataSource: DataSource,
  tenantId: string,
  branchIds: string[] | null,
): Promise<DataFreshness> {
  const [row] = await dataSource.query<
    {
      pendingSales: string | number | null;
      failedSales: string | number | null;
      devicesWithPendingSales: string | number | null;
      lastDeviceSyncAt: Date | string | null;
    }[]
  >(
    `SELECT COALESCE(SUM(d."pendingSales"), 0) AS "pendingSales",
            COALESCE(SUM(d."failedSales"), 0) AS "failedSales",
            COUNT(*) FILTER (WHERE d."pendingSales" > 0) AS "devicesWithPendingSales",
            MAX(d."lastSyncAt") AS "lastDeviceSyncAt"
     FROM devices d
     LEFT JOIN registers rg ON rg.id = d."registerId"
     WHERE d."tenantId" = $1 AND d."revokedAt" IS NULL
       AND ($2::uuid[] IS NULL OR rg."branchId" = ANY($2::uuid[]))`,
    [tenantId, branchIds],
  );
  const pendingSales = Number(row?.pendingSales ?? 0);
  const failedSales = Number(row?.failedSales ?? 0);
  const last = row?.lastDeviceSyncAt ?? null;
  return {
    generatedAt: new Date().toISOString(),
    pendingSales,
    failedSales,
    devicesWithPendingSales: Number(row?.devicesWithPendingSales ?? 0),
    lastDeviceSyncAt: last ? new Date(last).toISOString() : null,
    complete: pendingSales === 0 && failedSales === 0,
  };
}
