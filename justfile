default:
    @just --list

patch:
    just bump patch

minor:
    just bump minor

major:
    just bump major

bump PART:
    @case "{{PART}}" in patch|minor|major) ;; *) echo "Usage: just bump patch|minor|major"; exit 2 ;; esac
    @if [ -n "$(git status --porcelain)" ]; then echo "Working tree is dirty; commit or stash changes first."; exit 1; fi
    bun run check
    node -e 'const fs = require("fs"); const part = process.argv[1]; const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); const [major, minor, patch] = pkg.version.split(".").map(Number); if ([major, minor, patch].some(Number.isNaN)) throw new Error(`Unsupported version: ${pkg.version}`); if (part === "major") pkg.version = `${major + 1}.0.0`; if (part === "minor") pkg.version = `${major}.${minor + 1}.0`; if (part === "patch") pkg.version = `${major}.${minor}.${patch + 1}`; fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n"); console.log(pkg.version);' {{PART}}
    @version="$(node -p 'require("./package.json").version')" && git add package.json && git commit -m "chore(release): v$version" && git tag "v$version" && echo "Created v$version. Push with: git push origin HEAD --follow-tags"
