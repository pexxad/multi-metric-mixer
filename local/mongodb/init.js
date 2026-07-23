const metrics = db.getSiblingDB('metrics')
metrics.createUser({
  user: 'mmm_reader',
  pwd: 'local-mongo-reader',
  roles: [{ role: 'read', db: 'metrics' }],
})

// One document per region: a stable dimension that can be joined with
// PostgreSQL sales.region_id in the local cross-source demo.
metrics.regions.insertMany([
  { regionId: 101, regionName: '北海道・東北', territory: 'North', areaManager: '佐藤 葵', monthlyTarget: 5200, active: true },
  { regionId: 102, regionName: '関東',       territory: 'East',  areaManager: '田中 蓮', monthlyTarget: 6800, active: true },
  { regionId: 103, regionName: '中部',       territory: 'Central', areaManager: '鈴木 凛', monthlyTarget: 4700, active: true },
  { regionId: 104, regionName: '関西',       territory: 'West',  areaManager: '伊藤 湊', monthlyTarget: 6100, active: true },
  { regionId: 105, regionName: '中国・四国', territory: 'West',  areaManager: '山本 澪', monthlyTarget: 4500, active: true },
  { regionId: 106, regionName: '九州・沖縄', territory: 'South', areaManager: '高橋 樹', monthlyTarget: 4300, active: true },
])

// Event documents deliberately include optional and nested fields so that
// evolving JSON-like schema exploration can be exercised.
metrics.events.insertMany([
  { eventId: 'evt-001', regionId: 101, category: 'Hardware', eventType: 'product_view', count: 14, occurredAt: new Date('2026-07-01T09:00:00Z'), context: { channel: 'web', device: 'desktop' }, tags: ['campaign-summer'] },
  { eventId: 'evt-002', regionId: 102, category: 'Software', eventType: 'trial_start',  count: 7,  occurredAt: new Date('2026-07-02T10:30:00Z'), context: { channel: 'partner', device: 'tablet' }, tags: ['partner'] },
  { eventId: 'evt-003', regionId: 103, category: 'Hardware', eventType: 'download',     count: 5,  occurredAt: new Date('2026-07-03T11:15:00Z'), context: { channel: 'web', device: 'mobile' }, tags: [] },
  { eventId: 'evt-004', regionId: 104, category: 'Services', eventType: 'inquiry',      count: 9,  occurredAt: new Date('2026-07-04T02:40:00Z'), context: { channel: 'direct', device: 'desktop' }, campaign: { id: 'cmp-2026-07', source: 'email' } },
  { eventId: 'evt-005', regionId: 105, category: 'Software', eventType: 'product_view', count: 18, occurredAt: new Date('2026-07-05T05:25:00Z'), context: { channel: 'web', device: 'mobile' }, tags: ['campaign-summer', 'returning'] },
  { eventId: 'evt-006', regionId: 106, category: 'Services', eventType: 'inquiry',      count: 4,  occurredAt: new Date('2026-07-06T07:50:00Z'), context: { channel: 'partner', device: 'desktop' } },
  { eventId: 'evt-007', regionId: 101, category: 'Software', eventType: 'trial_start',  count: 11, occurredAt: new Date('2026-07-08T00:10:00Z'), context: { channel: 'direct', device: 'desktop' }, campaign: { id: 'cmp-2026-07', source: 'seminar' } },
  { eventId: 'evt-008', regionId: 102, category: 'Hardware', eventType: 'product_view', count: 22, occurredAt: new Date('2026-07-09T03:35:00Z'), context: { channel: 'web', device: 'mobile' }, tags: ['new-user'] },
  { eventId: 'evt-009', regionId: 103, category: 'Services', eventType: 'download',     count: 6,  occurredAt: new Date('2026-07-10T08:05:00Z'), context: { channel: 'partner', device: 'tablet' } },
  { eventId: 'evt-010', regionId: 104, category: 'Software', eventType: 'trial_start',  count: 13, occurredAt: new Date('2026-07-12T04:45:00Z'), context: { channel: 'direct', device: 'desktop' }, tags: ['campaign-summer'] },
  { eventId: 'evt-011', regionId: 105, category: 'Hardware', eventType: 'product_view', count: 16, occurredAt: new Date('2026-07-14T06:20:00Z'), context: { channel: 'web', device: 'desktop' } },
  { eventId: 'evt-012', regionId: 106, category: 'Software', eventType: 'download',     count: 8,  occurredAt: new Date('2026-07-16T01:30:00Z'), context: { channel: 'web', device: 'mobile' }, campaign: { id: 'cmp-2026-07', source: 'search' } },
  { eventId: 'evt-013', regionId: 101, category: 'Services', eventType: 'inquiry',      count: 3,  occurredAt: new Date('2026-07-18T10:55:00Z'), context: { channel: 'partner', device: 'desktop' }, tags: null },
  { eventId: 'evt-014', regionId: 102, category: 'Software', eventType: 'product_view', count: 25, occurredAt: new Date('2026-07-20T02:15:00Z'), context: { channel: 'web', device: 'mobile' }, tags: ['returning'] },
  { eventId: 'evt-015', regionId: 103, category: 'Hardware', eventType: 'inquiry',      count: 7,  occurredAt: new Date('2026-07-21T09:40:00Z'), context: { channel: 'direct', device: 'desktop' }, campaign: { id: 'cmp-2026-08', source: 'event' } },
  { eventId: 'evt-016', regionId: 104, category: 'Services', eventType: 'download',     count: 10, occurredAt: new Date('2026-07-22T05:05:00Z'), context: { channel: 'web', device: 'tablet' } },
  { eventId: 'evt-017', regionId: 105, category: 'Software', eventType: 'trial_start',  count: 12, occurredAt: new Date('2026-07-23T07:25:00Z'), context: { channel: 'partner', device: 'desktop' }, tags: ['partner', 'qualified'] },
  { eventId: 'evt-018', regionId: 106, category: 'Hardware', eventType: 'product_view', count: 19, occurredAt: new Date('2026-07-23T11:50:00Z'), context: { channel: 'web', device: 'mobile' }, tags: ['campaign-summer'] },
])
