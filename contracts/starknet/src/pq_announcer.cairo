//! pq_announcer — PQ recipient-discovery transport for Specter × STRK20.
//!
//! The ONLY chain-specific piece. Emits ML-KEM ciphertext CHUNKS as Cairo events
//! so recipients can scan and decapsulate the one-time key. No token / note /
//! pool logic — that is STRK20's native Privacy Pool. See ../ARCHITECTURE.md.
//!
//! Phase 0 skeleton — pending toolchain (task #11) to compile/deploy on Sepolia.

#[starknet::interface]
pub trait IPqAnnouncer<TContractState> {
    /// Publish one chunk of a chunked announcement. Recipients filter by
    /// `view_tag` (fast reject) then reassemble `chunk` across `total_chunks`.
    /// `viewing_key_tag` powers optional PQ viewing-key disclosure.
    fn announce(
        ref self: TContractState,
        announcement_id: felt252,
        view_tag: felt252,
        viewing_key_tag: felt252,
        total_chunks: u32,
        chunk_index: u32,
        ephemeral_pubkey: Array<felt252>,
        chunk: Array<felt252>,
    );

    fn version(self: @TContractState) -> felt252;
    fn announced_count(self: @TContractState) -> u64;
}

#[starknet::contract]
mod PqAnnouncer {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    const VERSION: felt252 = 'pqann-v1';

    #[storage]
    struct Storage {
        announced_count: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        AnnouncementChunk: AnnouncementChunk,
    }

    /// Scrubbed transport event — carries only PQ discovery material, never a
    /// depositor/recipient identity (STRK20 hides the transfer itself).
    #[derive(Drop, starknet::Event)]
    struct AnnouncementChunk {
        #[key]
        announcement_id: felt252,
        #[key]
        view_tag: felt252,
        viewing_key_tag: felt252,
        chunk_index: u32,
        total_chunks: u32,
        ephemeral_pubkey: Array<felt252>,
        chunk: Array<felt252>,
    }

    #[abi(embed_v0)]
    impl PqAnnouncerImpl of super::IPqAnnouncer<ContractState> {
        fn announce(
            ref self: ContractState,
            announcement_id: felt252,
            view_tag: felt252,
            viewing_key_tag: felt252,
            total_chunks: u32,
            chunk_index: u32,
            ephemeral_pubkey: Array<felt252>,
            chunk: Array<felt252>,
        ) {
            self
                .emit(
                    AnnouncementChunk {
                        announcement_id,
                        view_tag,
                        viewing_key_tag,
                        chunk_index,
                        total_chunks,
                        ephemeral_pubkey,
                        chunk,
                    },
                );
            self.announced_count.write(self.announced_count.read() + 1);
        }

        fn version(self: @ContractState) -> felt252 {
            VERSION
        }

        fn announced_count(self: @ContractState) -> u64 {
            self.announced_count.read()
        }
    }
}
