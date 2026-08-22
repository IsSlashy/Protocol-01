/**
 * Send: address, amount, sign, done. One screen.
 *
 * 🎯 WHY THIS IS ONE SCREEN AND NOT TWO
 * ─────────────────────────────────────
 * Sending used to be Send → SendConfirm. CONTINUE did no network work at all:
 * it validated the same two fields the button was already gating on, then
 * re-rendered the same recipient, the same amount and the same fee on a new
 * route, and only THEN offered the button that actually signs. A confirmation
 * step that shows nothing the previous screen did not show is not a safeguard,
 * it is a second chance to read numbers the user just typed.
 *
 * So the signing happens here. The user types, sees the fee, presses Send once.
 *
 * 🚨 THE FEE WAS PRINTED TWICE, AND ONCE IT WAS ARITHMETIC. Send showed
 * "ESTIMATED FEE ~0.000005", SendConfirm showed "NETWORK FEE ~0.000005" plus a
 * TOTAL line computed from it. Three numbers for one 5000-lamport constant. It
 * appears once now, next to the amount it applies to.
 *
 * ⛔ THE FULL-SCREEN SUCCESS PAGE IS GONE. It was a tick, a headline, a repeat
 * of the three values, an explorer link and a DONE button whose only job was to
 * go home. A send that worked returns the user to the wallet, where the balance
 * has changed and the transaction is in the list. That is the receipt.
 *
 * ⚠️ ERRORS SIT UNDER THE FIELD THAT CAUSED THEM. One `localError` string used
 * to collect "invalid address", "invalid amount" and "insufficient balance"
 * into a single banner floating between the two inputs, so the message never
 * said which box was wrong. Three states, three places.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EyeOff } from 'lucide-react';

import { useWalletStore } from '@/shared/store/wallet';
import { isValidSolanaAddress } from '@/shared/services/wallet';
import {
  parseMetaAddress,
  generateStealthAddress,
  createStealthMemo,
} from '@/shared/services/stealth';
import { Amount, Button, Eyebrow, Field, Panel, Pill, Screen } from '@/popup/ui';

/** The base signature fee. Stated once, on this screen, next to the amount. */
const NETWORK_FEE_SOL = 0.000005;

/** Left behind by the percentage shortcuts so the fee still has room. */
const FEE_RESERVE_SOL = 0.001;

const PERCENTAGES = [25, 50, 75, 100] as const;

export default function Send() {
  const navigate = useNavigate();
  const { solBalance, network, sendTransaction, isLoading, error } = useWalletStore();

  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');

  // One state per thing that can be wrong, so each message can sit under the
  // control it is about.
  const [recipientError, setRecipientError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [sendError, setSendError] = useState('');

  const [isStealthSend, setIsStealthSend] = useState(false);
  const [stealthAddressValid, setStealthAddressValid] = useState(false);

  // Check if recipient is a meta-address (stealth)
  useEffect(() => {
    if (recipient.startsWith('st:')) {
      setIsStealthSend(true);
      try {
        parseMetaAddress(recipient);
        setStealthAddressValid(true);
        setRecipientError('');
      } catch {
        setStealthAddressValid(false);
        if (recipient.length > 10) {
          setRecipientError('Invalid stealth meta-address format');
        }
      }
    } else {
      setIsStealthSend(false);
      setStealthAddressValid(false);
    }
  }, [recipient]);

  const stealth = isStealthSend && stealthAddressValid;

  const handleSend = async () => {
    setRecipientError('');
    setAmountError('');
    setSendError('');

    if (!recipient) {
      setRecipientError('Please enter a recipient address');
      return;
    }

    if (isStealthSend) {
      if (!stealthAddressValid) {
        setRecipientError('Invalid stealth meta-address');
        return;
      }
    } else if (!isValidSolanaAddress(recipient)) {
      setRecipientError('Invalid Solana address');
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setAmountError('Please enter a valid amount');
      return;
    }

    if (parseFloat(amount) > solBalance) {
      setAmountError('Insufficient balance');
      return;
    }

    // ⚠️ Unchanged from the two-screen flow: a stealth send derives a fresh
    // address here and MUST publish its ephemeral key in an on-chain memo, or
    // the recipient's scanner can never find the payment.
    let destination = recipient;
    let memo: string | undefined;

    if (stealth) {
      try {
        const { stealthAddress, ephemeralPubKey } = await generateStealthAddress(recipient);
        destination = stealthAddress.toBase58();
        memo = createStealthMemo(Uint8Array.from(ephemeralPubKey));
      } catch {
        setRecipientError('Failed to generate stealth address');
        return;
      }
    }

    try {
      await sendTransaction(destination, parseFloat(amount), memo);
      // Home is the receipt: the balance has moved and the transaction is in
      // the list there. A success screen with a Done button says less.
      navigate('/');
    } catch (err) {
      setSendError((err as Error).message);
    }
  };

  const canSend = Boolean(recipient) && Boolean(amount) && (!isStealthSend || stealthAddressValid);

  return (
    <Screen
      title="Send"
      onBack={() => navigate(-1)}
      action={network === 'devnet' ? <Pill tone="warn">Devnet</Pill> : undefined}
      footer={
        <>
          <Button
            full
            size="lg"
            icon={stealth ? EyeOff : undefined}
            loading={isLoading}
            disabled={!canSend}
            onClick={() => void handleSend()}
          >
            {stealth ? 'Send privately' : 'Send'}
          </Button>
          {/* The failure of the action, under the action. */}
          {(sendError || error) && (
            <p role="alert" className="mt-2 text-tiny text-p01-red">
              {sendError || error}
            </p>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <Eyebrow>Available</Eyebrow>
          <div className="mt-1.5">
            <Amount value={solBalance.toFixed(4)} unit="SOL" size="xl" />
          </div>
        </div>

        <Field
          label="Recipient"
          id="send-recipient"
          type="text"
          value={recipient}
          onChange={(e) => {
            setRecipient(e.target.value);
            setRecipientError('');
            setSendError('');
          }}
          placeholder="Address or st:… meta-address"
          error={recipientError || undefined}
          className="font-mono"
        />

        <div className="flex flex-col gap-2">
          <Field
            label="Amount"
            id="send-amount"
            type="number"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountError('');
              setSendError('');
            }}
            placeholder="0.00"
            step="0.0001"
            min="0"
            max={solBalance}
            suffix="SOL"
            error={amountError || undefined}
            className="font-mono"
          />

          <div className="flex gap-2">
            {PERCENTAGES.map((percent) => (
              <button
                key={percent}
                onClick={() => {
                  const maxAmount = Math.max(0, solBalance - FEE_RESERVE_SOL);
                  setAmount(String(((maxAmount * percent) / 100).toFixed(4)));
                  setAmountError('');
                  setSendError('');
                }}
                className="min-h-[44px] flex-1 rounded-lg border border-p01-border text-tiny text-p01-text-muted transition-colors duration-exit hover:border-p01-border-light hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan tabular"
              >
                {percent}%
              </button>
            ))}
          </div>

          {/* The fee. Once. */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-tiny text-p01-text-dim">Network fee</span>
            <span className="font-mono text-tiny text-p01-text-muted tabular">
              ~{NETWORK_FEE_SOL} SOL
            </span>
          </div>
        </div>

        {/* Said once, and only when it applies. */}
        {stealth && (
          <Panel tone="quiet">
            <div className="flex items-start gap-2.5">
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-p01-cyan" aria-hidden="true" />
              <p className="text-tiny text-p01-text-muted">
                This lands on a fresh address derived for this payment alone, so it is not tied
                to the recipient&apos;s published address. Your wallet still signs and pays for
                it, and the link stays broken only until they sweep the funds onward.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </Screen>
  );
}
