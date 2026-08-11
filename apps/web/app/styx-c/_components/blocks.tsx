/**
 * Presentational blocks for the Terminal Noir direction. Server components:
 * the page ships no client JavaScript of its own.
 */
import type { ReactNode } from 'react';
import styles from '../styx-c.module.css';
import {
  CRYPTO_ROWS,
  PROGRAMS,
  VERIFIED,
  explorerUrl,
  sourceUrl,
} from './data';

export function Ext({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

export function SectionHead({
  id,
  idx,
  title,
  dek,
}: {
  id: string;
  idx: string;
  title: string;
  dek?: ReactNode;
}) {
  return (
    <>
      <div className={styles.secHead} id={`${id}-head`}>
        <span className={styles.secIdx} aria-hidden="true">
          [{idx}]
        </span>
        <h2 className={styles.secTitle}>{title}</h2>
      </div>
      {dek ? <p className={styles.secDek}>{dek}</p> : null}
    </>
  );
}

const STATUS_LABEL = {
  pq: 'POST-QUANTUM',
  hybrid: 'HYBRID',
  classical: 'CLASSICAL',
} as const;

export function ProgramTable() {
  return (
    <>
      <div className={styles.tblWrap}>
        <table className={`${styles.tbl} ${styles.tblWide}`}>
          <caption className="sr-only">
            Programs deployed on Solana devnet, with explorer and source links
          </caption>
          <thead>
            <tr>
              <th scope="col">Program</th>
              <th scope="col">Program ID (devnet)</th>
              <th scope="col">Role</th>
              <th scope="col">Verify</th>
            </tr>
          </thead>
          <tbody>
            {PROGRAMS.map((p) => (
              <tr key={p.id}>
                <td className={styles.cellName}>{p.name}</td>
                <td className={styles.cellId}>
                  <Ext href={explorerUrl(p.id)}>{p.id}</Ext>
                </td>
                <td>{p.role}</td>
                <td className={styles.cellLinks}>
                  <Ext href={explorerUrl(p.id)} className={styles.linkBr}>
                    [explorer]
                  </Ext>
                  <Ext href={sourceUrl(p.sourcePath)} className={styles.linkBr}>
                    [source]
                  </Ext>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.tblCap}>
        Existence and executability re-checked against {VERIFIED.rpc} at slot{' '}
        {VERIFIED.slot} on {VERIFIED.date}. Each ID is the{' '}
        <code>declare_id!</code> in the linked source file. Mainnet: none. If a
        link fails, this page is failing honestly.
      </p>
    </>
  );
}

export function CryptoTable() {
  return (
    <>
      <div className={styles.tblWrap}>
        <table className={`${styles.tbl} ${styles.tblWide}`}>
          <caption className="sr-only">
            Cryptographic primitives and their quantum status
          </caption>
          <thead>
            <tr>
              <th scope="col">Layer</th>
              <th scope="col">Construction</th>
              <th scope="col">What it does</th>
              <th scope="col">Quantum status</th>
            </tr>
          </thead>
          <tbody>
            {CRYPTO_ROWS.map((r) => (
              <tr key={r.layer}>
                <td className={styles.cellName}>{r.layer}</td>
                <td className={styles.mono}>{r.construction}</td>
                <td>{r.job}</td>
                <td>
                  <span
                    className={`${styles.tag} ${
                      r.status === 'classical'
                        ? styles.tagWarn
                        : r.status === 'pq'
                          ? styles.tagOk
                          : ''
                    }`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  <div className={styles.tblCap}>{r.note}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.tblCap}>
        The honest summary: post-quantum on the proof and the encryption,
        classical on the transaction signature, because the chain imposes it.
      </p>
    </>
  );
}
