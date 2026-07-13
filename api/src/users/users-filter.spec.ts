import { BadRequestException } from '@nestjs/common';
import { buildUserFilters } from './users.service';
import { HierarchyService } from '../hierarchy/hierarchy.service';

describe('buildUserFilters (UAT users-list filters)', () => {
  it('returns empty SQL and touches no params when no filters given', () => {
    const params: unknown[] = ['scope'];
    expect(buildUserFilters({}, params)).toBe('');
    expect(params).toEqual(['scope']);
  });

  it('q filters name OR email OR phone with one ILIKE param', () => {
    const params: unknown[] = [];
    const sql = buildUserFilters({ q: ' priya ' }, params);
    expect(sql).toBe(' AND (u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone LIKE $1)');
    expect(params).toEqual(['%priya%']);
  });

  it('blank q is ignored', () => {
    const params: unknown[] = [];
    expect(buildUserFilters({ q: '   ' }, params)).toBe('');
    expect(params).toEqual([]);
  });

  it('role_id filters via active assignments', () => {
    const params: unknown[] = ['x'];
    const sql = buildUserFilters({ role_id: 7 }, params);
    expect(sql).toContain('fa.role_id = $2');
    expect(sql).toContain('fa.is_active');
    expect(params).toEqual(['x', 7]);
  });

  it('branch_id filters via active assignments', () => {
    const params: unknown[] = [];
    const sql = buildUserFilters({ branch_id: 3 }, params);
    expect(sql).toContain('fb.branch_id = $1');
    expect(params).toEqual([3]);
  });

  it('status appends an equality clause', () => {
    const params: unknown[] = [];
    const sql = buildUserFilters({ status: 'disabled' }, params);
    expect(sql).toBe(' AND u.status = $1');
    expect(params).toEqual(['disabled']);
  });

  it('invalid status -> 400', () => {
    expect(() => buildUserFilters({ status: 'zombie' as never }, [])).toThrow(BadRequestException);
  });

  it('filters compose in order with correct param indexes', () => {
    const params: unknown[] = ['scope1', 'scope2'];
    const sql = buildUserFilters({ q: 'a', role_id: 1, branch_id: 2, status: 'active' }, params);
    expect(sql).toContain('$3');   // q
    expect(sql).toContain('fa.role_id = $4');
    expect(sql).toContain('fb.branch_id = $5');
    expect(sql).toContain('u.status = $6');
    expect(params).toEqual(['scope1', 'scope2', '%a%', 1, 2, 'active']);
  });
});

describe('HierarchyService.activeFilter (include_inactive param)', () => {
  it('defaults to active-only', () => {
    expect(HierarchyService.activeFilter('b')).toBe(' AND b.is_active');
    expect(HierarchyService.activeFilter('b', false)).toBe(' AND b.is_active');
  });
  it('include_inactive removes the filter', () => {
    expect(HierarchyService.activeFilter('b', true)).toBe('');
  });
});
