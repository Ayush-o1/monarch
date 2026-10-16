export async function recordEvent(
  client,
  { tenancyId, actorType, actorLabel, type, payload = {} }
) {
  const result = await client.query(
    `INSERT INTO events (tenancy_id, actor_type, actor_label, type, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenancy_id, actor_type, actor_label, type, payload, created_at`,
    [tenancyId, actorType, actorLabel, type, JSON.stringify(payload)]
  );

  return result.rows[0];
}
