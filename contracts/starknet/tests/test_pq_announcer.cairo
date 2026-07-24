use snforge_std::{declare, ContractClassTrait, DeclareResultTrait};
use protocol01_starknet::pq_announcer::{IPqAnnouncerDispatcher, IPqAnnouncerDispatcherTrait};

fn deploy() -> IPqAnnouncerDispatcher {
    let contract = declare("PqAnnouncer").unwrap().contract_class();
    let (addr, _) = contract.deploy(@array![]).unwrap();
    IPqAnnouncerDispatcher { contract_address: addr }
}

#[test]
fn version_is_v1() {
    let d = deploy();
    assert(d.version() == 'pqann-v1', 'bad version');
}

#[test]
fn announce_increments_count() {
    let d = deploy();
    assert(d.announced_count() == 0, 'count not 0');
    // announcement_id, view_tag, viewing_key_tag, total_chunks, chunk_index, ephemeral_pubkey, chunk
    d.announce(111, 7, 42, 2, 0, array![10, 11], array![20, 21, 22]);
    assert(d.announced_count() == 1, 'count not 1');
    d.announce(111, 7, 42, 2, 1, array![10, 11], array![23, 24, 25]);
    assert(d.announced_count() == 2, 'count not 2');
}
