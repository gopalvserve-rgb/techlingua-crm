import { NotificationController } from './notification.controller';

/**
 * dev/132 ITEM C (task #217) — the popup surface polls GET /notifications?unread=1. This pins
 * that the controller forwards the unread flag + limit to the service for the caller's own id.
 */
describe('NotificationController — unread poll endpoint', () => {
  const list = jest.fn().mockResolvedValue([{ id: 7 }]);
  const count = jest.fn().mockResolvedValue({ unread: 3 });
  const svc = { list, unreadCount: count } as any;
  const ctrl = new NotificationController(svc);
  const me = { id: 42 };

  it('GET /notifications?unread=1 -> service.list(me, { unread:true })', async () => {
    await ctrl.list(me, '1', undefined);
    expect(list).toHaveBeenCalledWith(42, { unread: true, limit: 30 });
  });

  it('honours limit + treats unread=true the same as 1', async () => {
    await ctrl.list(me, 'true', '20');
    expect(list).toHaveBeenCalledWith(42, { unread: true, limit: 20 });
  });

  it('no unread param -> unread:false (full list)', async () => {
    await ctrl.list(me, undefined, undefined);
    expect(list).toHaveBeenCalledWith(42, { unread: false, limit: 30 });
  });

  it('the badge count endpoint is per-caller', async () => {
    expect(await ctrl.count(me)).toEqual({ unread: 3 });
    expect(count).toHaveBeenCalledWith(42);
  });
});
