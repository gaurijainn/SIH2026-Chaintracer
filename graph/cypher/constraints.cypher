// B1 Neo4j schema. Idempotent: safe to run on every start.
// Address identity is (chain, addr); Entity identity is (name, type).
CREATE CONSTRAINT address_chain_addr IF NOT EXISTS FOR (a:Address) REQUIRE (a.chain, a.addr) IS UNIQUE;
CREATE CONSTRAINT entity_name_type IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.type) IS UNIQUE;
// Speeds the idempotent MERGE of TRANSFER edges and tx-hash lookups.
CREATE INDEX transfer_tx IF NOT EXISTS FOR ()-[t:TRANSFER]-() ON (t.tx);
