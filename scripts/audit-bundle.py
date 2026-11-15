#!/usr/bin/env python3
"""Read-only source/upload-boundary check. Never prints credential/contact values."""
from pathlib import Path
import re,sys
root=Path(__file__).resolve().parents[1]
# Local dependencies/output are excluded from source uploads; archive verification
# runs separately on every actual member when the release bundle is made.
ignored={".git","node_modules","dist","build","coverage",".venv","venv","__pycache__",".pytest_cache",".mypy_cache",".ruff_cache","artifacts"}
forbidden_names={"AGENTS.md","SKILL.md","CLAUDE.md","CODEX-BRIEF.md",".cursorrules"}
forbidden_ext={".go",".java",".cs",".swift",".kt",".rb",".ex",".exs",".php",".pem",".key",".p12",".pfx",".sqlite",".sqlite3",".tfstate",".tfplan",".har"}
errors=[];files=[]
for p in root.rglob("*"):
 if not p.is_file():continue
 rel=p.relative_to(root)
 if set(rel.parts)&ignored:continue
 files.append(p)
 if p.is_symlink():errors.append((str(rel),"symlink"))
 if p.name in forbidden_names or ".github" in rel.parts or p.suffix.lower() in forbidden_ext:errors.append((str(rel),"excluded file type/instruction/workflow"))
 if p.name.startswith(".env") and p.name!=".env.example":errors.append((str(rel),"local environment file"))
 data=p.read_bytes()
 if b"\0" in data:errors.append((str(rel),"unexpected binary file"));continue
 text=data.decode("utf8")
 if re.search(r"SPDX-License-Identifier:\s*(?:AGPL|GPL|LGPL)|[\"]license[\"]\s*:\s*[\"](?:AGPL|GPL|LGPL)",text):errors.append((str(rel),"unexpected copyleft source label"))
 if re.search(r"/Users/[A-Za-z0-9._-]+/",text):errors.append((str(rel),"personal home path"))
 if re.search(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",text):errors.append((str(rel),"cloud access key shape"))
 for email in re.findall(r"(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+\-]{0,63}@[A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,}(?![\w.])",text):
  domain=email.rsplit("@",1)[1].lower()
  if domain not in {"example.com","example.org","example.net"} and not domain.endswith((".example",".invalid",".test",".localhost")):errors.append((str(rel),"non-reserved contact address"))
if not (root/"LICENSE").read_text().startswith("MIT License"):errors.append(("LICENSE","MIT license missing"))
import json
manifest=json.loads((root/"package.json").read_text())
if manifest.get("license") != "MIT":errors.append(("package.json","first-party license must be MIT"))
lock_path=root/"package-lock.json"
if lock_path.exists():
 for package,info in json.loads(lock_path.read_text()).get("packages",{}).items():
  license_name=info.get("license","")
  if re.search(r"(?:^|[^A-Za-z])(?:AGPL|GPL|LGPL|MPL|EPL|EUPL|SSPL)(?:-|$)",license_name):errors.append(("package-lock.json", "copyleft dependency: "+package))

for required in ["README.md","FIXTURES.md","package.json","package-lock.json",".gitignore","contracts/service-contract.json","contracts/openapi.yaml"]:
 if not (root/required).is_file():errors.append((required,"required file missing"))
if errors:
 for path,reason in sorted(set(errors)):print(path+": "+reason)
 sys.exit(1)
print(f"Bundle source boundary passed: {len(files)} files; MIT, supported source, reserved contact examples, no instruction/workflow files")
