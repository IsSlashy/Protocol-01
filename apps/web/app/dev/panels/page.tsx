"use client";

import { Component, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { Connection, Keypair } from "@solana/web3.js";
import StyxShell from "../../_styx/StyxShell";
import StyxField from "../../_styx/StyxField";
import { WalletProvider } from "@/components/WalletProvider";
import Stepper from "@/components/pay/Stepper";
import ChainCoinSelector from "@/components/pay/ChainCoinSelector";
import PoolPanel from "@/components/pay/PoolPanel";
import SubscribePanel from "@/components/pay/SubscribePanel";
import SubscriptionsPanel from "@/components/pay/SubscriptionsPanel";
import SendForm from "@/components/pay/SendForm";
import ReceivePanel from "@/components/pay/ReceivePanel";
import { ALL_ASSETS, getAdapter } from "@/lib/privacy/chains";
import type { DerivedIdentity } from "@/lib/privacy/chains/types";

/**
 * /dev/panels — DESIGN PREVIEW ONLY, development builds only.
 *
 * The pay panels can only be reached in the real app behind a connected
 * wallet and a signature, which no screenshot tool has. This route mounts
 * every panel side by side with inert props (a random owner, no signer, a
 * devnet connection) so their look can be checked against the rest of the
 * site without a wallet. Nothing here can move funds: `signOne` is null and
 * the owner key is thrown away on every load. `notFound()` in production.
 */

class Boundary extends Component<{ name: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { err: e.message };
  }
  render() {
    if (this.state.err) {
      return <p className="text-xs text-p01-red">{this.props.name}: {this.state.err}</p>;
    }
    return this.props.children;
  }
}

const owner = Keypair.generate().publicKey;
const meta = "p01pq:preview";

export default function PanelsPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const adapter = getAdapter("solana");
  const asset = ALL_ASSETS.find((a) => a.status === "live") ?? ALL_ASSETS[0]!;
  const identity = { chain: "solana", address: owner.toBase58() } as unknown as DerivedIdentity;
  const section = (title: string, node: ReactNode) => (
    <section className="mx-auto w-full max-w-5xl">
      <p className="styx-overline" style={{ marginBottom: "0.75rem" }}>{title}</p>
      <div className="glass p-6">{node}</div>
    </section>
  );

  return (
    <StyxShell>
      <StyxField />
      <WalletProvider network="devnet">
      <div className="styx-container styx-pay" style={{ paddingBlock: "2rem", display: "grid", gap: "2.5rem" }}>
        <p className="styx-overline">dev · panels preview · nothing here is live</p>
        {section("stepper + asset", (
          <div className="space-y-4">
            <Stepper current={1} />
            <ChainCoinSelector assets={ALL_ASSETS} selected={asset} onSelect={() => undefined} />
            <div className="inline-flex flex-wrap rounded-lg border border-p01-border bg-p01-surface p-1">
              {["Envoyer", "Recevoir", "Blinder", "S’abonner", "Abonnements"].map((label, i) => (
                <span key={label} className={i === 3 ? "rounded-md bg-p01-text px-3 py-1.5 text-sm font-medium text-p01-void" : "rounded-md px-3 py-1.5 text-sm font-medium text-p01-text-muted"}>{label}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <button className="btn-primary">Signer pour créer vos clés</button>
              <button className="btn-secondary">Rafraîchir</button>
              <button className="btn-ghost">Déconnecter</button>
            </div>
          </div>
        ))}
        {section("blinder (PoolPanel)", (
          <Boundary name="PoolPanel"><PoolPanel token="SOL" meta={meta} owner={owner} connection={connection} signOne={null} /></Boundary>
        ))}
        {section("s’abonner (SubscribePanel)", (
          <Boundary name="SubscribePanel"><SubscribePanel meta={meta} owner={owner} connection={connection} signOne={null} token="SOL" /></Boundary>
        ))}
        {section("abonnements (SubscriptionsPanel)", (
          <Boundary name="SubscriptionsPanel"><SubscriptionsPanel meta={meta} owner={owner} connection={connection} /></Boundary>
        ))}
        {section("envoyer (SendForm)", (
          <Boundary name="SendForm"><SendForm adapter={adapter} asset={asset} meta={meta} owner={owner} /></Boundary>
        ))}
        {section("recevoir (ReceivePanel)", (
          <Boundary name="ReceivePanel"><ReceivePanel adapter={adapter} identity={identity} destination={owner.toBase58()} meta={meta} owner={owner} /></Boundary>
        ))}
      </div>
      </WalletProvider>
    </StyxShell>
  );
}
