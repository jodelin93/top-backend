import { isCategoryVisible } from './category-branches';

describe('categories tied to branches', () => {
  it('shows a category of every branch to everyone', () => {
    expect(isCategoryVisible({ branchIds: null }, ['b-1'])).toBe(true);
    expect(isCategoryVisible({ branchIds: [] }, ['b-1'])).toBe(true);
  });

  it('shows a branch category to that branch’s staff only', () => {
    expect(isCategoryVisible({ branchIds: ['b-1'] }, ['b-1'])).toBe(true);
    expect(isCategoryVisible({ branchIds: ['b-2'] }, ['b-1'])).toBe(false);
  });

  it('shows every category to users of every branch', () => {
    expect(isCategoryVisible({ branchIds: ['b-2'] }, null)).toBe(true);
  });
});
