import { Raw, type FindOptionsWhere } from 'typeorm';
import type { Category } from '../database/entities/category.entity';
import { scopedBranchIds } from '../auth/branch-scope';

/**
 * Categories tied to branches (Category.branchIds; none = every branch). A
 * branch-limited user only sees the categories of their branches, and those
 * of every branch; users of every branch see them all.
 */
export const isCategoryVisible = (
  category: Pick<Category, 'branchIds'>,
  scope: readonly string[] | null = scopedBranchIds(),
) =>
  !scope ||
  !category.branchIds?.length ||
  category.branchIds.some((b) => scope.includes(b));

/** The same rule as a find condition (empty for users of every branch) */
export function categoryVisibleWhere(
  scope: readonly string[] | null = scopedBranchIds(),
): FindOptionsWhere<Category> {
  if (!scope) return {};
  return {
    branchIds: Raw(
      (column) =>
        `(${column} IS NULL OR cardinality(${column}) = 0 OR ${column} && :categoryScope)`,
      { categoryScope: [...scope] },
    ),
  };
}
