# CSDB TypeScript Library

> **Start here:** Project-wide information, planning, and community resources
> live in the [main CSDB repository](https://github.com/csvdatabase/csdb).

## Introduction

This repository contains the native TypeScript implementation of CSDB. It reads
and writes `.csdb` files and supports fluent table queries and SQL.

The package name is `@csvdatabase/csdb`.

## Use

```bash
npm install @csvdatabase/csdb
```

```ts
import { openCSDB } from "@csvdatabase/csdb";

const db = await openCSDB("payroll.csdb");
const workers = db.table("workers").where("active", "=", true).all();
```

## Development

Install dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
npm run build
```
