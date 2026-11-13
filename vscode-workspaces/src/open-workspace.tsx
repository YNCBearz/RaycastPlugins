import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  Action,
  ActionPanel,
  closeMainWindow,
  getPreferenceValues,
  Icon,
  List,
  open,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useFrecencySorting, usePromise } from "@raycast/utils";

const DEFAULT_DIR = "~/Documents/vscode-workspace";
const DEFAULT_EDITOR = "com.microsoft.VSCode";
const EXTENSION = ".code-workspace";

interface Workspace {
  id: string;
  name: string;
  filePath: string;
  folders: string[];
  modifiedAt: Date;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Remove // and /* *\/ comments plus trailing commas, so JSONC workspace files can be parsed. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readFolders(filePath: string): Promise<string[]> {
  try {
    const json = JSON.parse(stripJsonc(await readFile(filePath, "utf8"))) as {
      folders?: { path?: string; uri?: string; name?: string }[];
    };
    const baseDir = path.dirname(filePath);
    return (json.folders ?? [])
      .map((f) => {
        if (f.path) return path.resolve(baseDir, expandHome(f.path));
        return f.uri ?? f.name ?? "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function loadWorkspaces(dir: string): Promise<Workspace[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(EXTENSION));

  const workspaces = await Promise.all(
    files.map(async (e) => {
      const filePath = path.join(dir, e.name);
      const [folders, info] = await Promise.all([
        readFolders(filePath),
        stat(filePath),
      ]);
      return {
        id: filePath,
        name: e.name.slice(0, -EXTENSION.length),
        filePath,
        folders,
        modifiedAt: info.mtime,
      };
    }),
  );

  return workspaces.sort((a, b) => a.name.localeCompare(b.name));
}

function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const dir = expandHome(prefs.workspaceDir?.trim() || DEFAULT_DIR);
  const editor = prefs.editor?.bundleId ?? prefs.editor?.path ?? DEFAULT_EDITOR;
  const editorName = prefs.editor?.name ?? "Visual Studio Code";

  const { data, isLoading, error, revalidate } = usePromise(loadWorkspaces, [
    dir,
  ]);
  const {
    data: sorted,
    visitItem,
    resetRanking,
  } = useFrecencySorting(data, { key: (w) => w.id });

  async function openWorkspace(ws: Workspace) {
    try {
      await visitItem(ws);
      await open(ws.filePath, editor);
      await closeMainWindow({ clearRootSearch: true });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: `Failed to open ${ws.name}`,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Cannot read workspace folder"
          description={`${tildify(dir)}\n${error.message}\nChange the folder in the extension preferences.`}
        />
      </List>
    );
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search workspaces...">
      <List.EmptyView
        icon={Icon.Folder}
        title="No workspaces found"
        description={`No *${EXTENSION} files in ${tildify(dir)}`}
      />
      {sorted.map((ws) => (
        <List.Item
          key={ws.id}
          icon={{ fileIcon: ws.filePath }}
          title={ws.name}
          subtitle={ws.folders.map(tildify).join(", ")}
          keywords={ws.folders.map((f) => path.basename(f))}
          accessories={[
            ...(ws.folders.length > 1
              ? [{ tag: `${ws.folders.length} folders` }]
              : []),
            {
              date: ws.modifiedAt,
              tooltip: `Modified ${ws.modifiedAt.toLocaleString()}`,
            },
          ]}
          actions={
            <ActionPanel>
              <Action
                title={`Open in ${editorName}`}
                icon={Icon.Code}
                onAction={() => openWorkspace(ws)}
              />
              <Action.ShowInFinder path={ws.filePath} />
              <Action.CopyToClipboard
                title="Copy Path"
                content={ws.filePath}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
              <ActionPanel.Section>
                <Action
                  title="Reload"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={revalidate}
                />
                <Action
                  title="Reset Ranking"
                  icon={Icon.ArrowCounterClockwise}
                  onAction={() => resetRanking(ws)}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
