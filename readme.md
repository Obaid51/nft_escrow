
# 🎯 NFT Escrow Program (Solana + Anchor)

This is a Solana smart contract (Anchor-based) for securely escrowing NFTs. It supports both standard SPL NFTs and compressed NFTs (e.g., Bubblegum). Users can initialize an escrow account, deposit NFTs into it, and later withdraw them.

---

## 📦 Features

- Initialize a user-bound escrow PDA
- Deposit one or multiple NFTs (standard or compressed)
- Withdraw NFT with authority check
- Built using [`anchor-lang`] and [`anchor-spl`]

---

## 🧰 Requirements

- [Rust](httpswww.rust-lang.orgtoolsinstall)
- [Solana CLI](httpsdocs.solana.comcliinstall-solana-cli-tools)
- [Node.js](httpsnodejs.orgen) + Yarn
- [Anchor CLI](httpsbook.anchor-lang.comgetting_startedinstallation.html)

```
cargo install --git httpsgithub.comcoral-xyzanchor avm --locked --force
avm install 0.30.0
avm use 0.30.0 
```
## Build and Deploy
```
anchor build
anchor deploy --provider.cluster devnet
```

## Running Tests

All tests are in `tests` and include

-   ✅ Initializing escrow account
    
-   🎁 Depositing NFT
    
-   🧾 Withdrawing NFT
    

 Requires a funded wallet with 1-SPL-token NFTs on Devnet.

### Run the full suite

`anchor test --provider.cluster devnet` 

This will

-   Build the program
    
-   Deploy to Devnet
    
-   Run Mocha tests via `ts-mocha`
    

----------

## ⚙️ NFT Setup (Devnet)

If you don’t already own NFTs on Devnet, create one

`solana airdrop 2 --url devnet
spl-token create-token --url devnet
spl-token create-account MINT --url devnet
spl-token mint MINT 1 --url devnet` 

Use the resulting `MINT` address in test scripts
