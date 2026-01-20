# Solana Lock Generator

Outil pour générer un `Cargo.lock` compatible avec Solana/Anchor en évitant les dépendances qui requièrent Rust edition 2024.

## Le Problème

Les nouvelles versions de certains crates Rust (constant_time_eq, base64ct, etc.) requièrent `edition = "2024"`, mais Solana utilise Rust 1.75 qui ne supporte pas cette édition.

## La Solution

Cet outil :
1. Analyse les dépendances du projet
2. Identifie les crates problématiques
3. Génère un `Cargo.lock` avec des versions compatibles

## Usage

```bash
./generate-compatible-lock.sh /path/to/anchor/project
```

## Crates Problématiques Connus

| Crate | Version Problématique | Version Compatible |
|-------|----------------------|-------------------|
| constant_time_eq | >= 0.4.0 | 0.3.1 |
| base64ct | >= 1.7.0 | 1.6.0 |
| subtle | >= 2.6.0 | 2.5.0 |

## Contribuer

Si vous trouvez d'autres crates problématiques, ouvrez une issue !
