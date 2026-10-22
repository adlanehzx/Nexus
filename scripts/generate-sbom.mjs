#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

function findPackages() {
  const dirs = ["packages", "services", "apps"];
  const pkgs = [];

  for (const dir of dirs) {
    const fullDir = join(root, dir);
    if (!existsSync(fullDir)) continue;
    for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(fullDir, entry.name, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
          pkgs.push({
            name: pkg.name ?? `${dir}/${entry.name}`,
            version: pkg.version ?? "1.0.0",
            license: pkg.license ?? "AGPL-3.0-or-later",
            description: pkg.description ?? "",
            directory: `${dir}/${entry.name}`,
            dependencies: Object.keys(pkg.dependencies ?? {}),
          });
        } catch {}
      }
    }
  }
  return pkgs;
}

export function generateSbom() {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const subPackages = findPackages();
  const timestamp = new Date().toISOString();

  const spdxPackages = [
    {
      SPDXID: "SPDXRef-Package-Nexus-Root",
      name: "nexus",
      versionInfo: rootPkg.version ?? "1.0.0",
      packageFileName: "nexus-1.0.0.tar.gz",
      packageSupplier: "Organization: NEXUS Project",
      licenseDeclared: rootPkg.license ?? "AGPL-3.0-or-later",
      licenseConcluded: rootPkg.license ?? "AGPL-3.0-or-later",
      filesAnalyzed: false,
      description: rootPkg.description ?? "NEXUS — local multi-device AI assistant",
      homepage: "https://github.com/adlanehzx/Nexus",
    },
    ...subPackages.map((pkg, idx) => ({
      SPDXID: `SPDXRef-Package-${pkg.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${idx}`,
      name: pkg.name,
      versionInfo: pkg.version,
      packageSupplier: "Organization: NEXUS Project",
      licenseDeclared: pkg.license,
      licenseConcluded: pkg.license,
      filesAnalyzed: false,
      description: pkg.description,
      sourceInfo: pkg.directory,
    })),
  ];

  const spdxRelationships = subPackages.map((pkg, idx) => ({
    spdxElementId: "SPDXRef-Package-Nexus-Root",
    relatedSpdxElement: `SPDXRef-Package-${pkg.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${idx}`,
    relationshipType: "CONTAINS",
  }));

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "NEXUS-SBOM",
    documentNamespace: `https://github.com/adlanehzx/Nexus/releases/tag/v${rootPkg.version}/sbom.spdx.json`,
    creationInfo: {
      created: timestamp,
      creators: ["Tool: nexus-sbom-generator-1.0.0", "Organization: NEXUS Project"],
    },
    packages: spdxPackages,
    relationships: spdxRelationships,
  };
}

if (process.argv[1] && process.argv[1].endsWith("generate-sbom.mjs")) {
  const sbom = generateSbom();
  const outDir = join(root, "release");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "sbom.spdx.json");
  writeFileSync(outFile, JSON.stringify(sbom, null, 2), "utf8");
  console.log(`Generated SPDX SBOM at: ${outFile} (${sbom.packages.length} packages)`);
}
