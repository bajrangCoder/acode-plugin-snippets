import ajax from "@deadlyjack/ajax";
import plugin from '../plugin.json';

const pluginId = plugin.id;
const config = ace.require('ace/config');
const { snippetManager } = ace.require('ace/snippets');

class AcodeSnippets {
  #snippetsLocation;
  #changeModeListner;
  #baseUrl = '';

  constructor() {
    this.#setVariables();
    this.#changeModeListner = this.#onChangeMode.bind(this);
    if (!appSettings.value[plugin.id]) {
      this.#saveSnippetLocation('');
    }
  }

  async init() {
    const { editor } = editorManager;
    editor.setOption('enableBasicAutocompletion', true);
    editor.setOption('enableLiveAutocompletion', true);
    editor.on("changeMode", this.#changeModeListner);
    this.#loadCommands();
    this.#onChangeMode();
  }

  async destroy() {
    const { editor } = editorManager;
    editor.on("changeMode", this.#changeModeListner);
    if (snippetManager.files) {
      snippetManager.files = [];
    }
    this.#unloadCommands();
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  /**
   * @param {string} value
   */
  set baseUrl(value) {
    this.#baseUrl = value;
    const snippetLocaion = this.#getSnippetLocation();
    if (snippetLocaion) {
      this.#snippetsLocation = snippetLocaion;
      return;
    }
    this.#snippetsLocation = this.#joinUrl(value, 'snippets');
  }

  async #onChangeMode() {
    const { editor } = editorManager;
    this.#loadSnippetsForMode(editor.session.$mode);
  }

  async #loadSnippetsForMode(mode) {
    if (typeof mode === 'string') {
      mode = config.$modes[mode];
    }

    if (!mode) return;

    if (!snippetManager.files) {
      snippetManager.files = {};
    }

    await this.#loadSnippetFile(mode);
    if (mode.modes) {
      mode.modes.forEach(this.#loadSnippetsForMode);
    }
  }

  async #loadSnippetFile({ $id: id }) {
    if (snippetManager.files[id]) return;

    const modeName = id.split('/').pop();
    snippetManager.files[id] = {};
    try {
      const fileUrl = this.#joinUrl(this.#snippetsLocation, `${modeName}.snippets`);
      let snippetText = '';
      try {
        snippetText = await this.#readFile(fileUrl);
      } catch {
        //ignore, not found
      }
      this.#defineSnippets(modeName, snippetText, this.#includeScopes(modeName));
      const module = ace.require(`ace/snippets/${modeName}`);
      if (!module) {
        snippetManager.files[id] = true;
        return;
      }
      snippetManager.files[id] = module;
      if (!module.snippets && module.snippetText) {
        module.snippets = snippetManager.parseSnippetFile(module.snippetText);
      }
      snippetManager.register(module.snippets || [], module.scope);

      if (module.includeScopes) {
        snippetManager.snippetMap[module.scope].includeScopes = module.includeScopes;
        module.includeScopes.forEach((scope) => {
          this.#loadSnippetsForMode(`ace/mode/${scope}`);
        });
      }
    } catch (error) {
      console.error(error);
    }
  }

  #includeScopes(mode) {
    switch (mode) {
      case 'velocity':
        return ['html', 'javascript', 'css'];

      case 'markdown':
        return ['html'];

      default:
        return null;
    }
  }

  #setVariables() {
    const { variables } = snippetManager
    variables.FILEPATH = () => {
      const { SAFMode, uri, filename } = editorManager.activeFile;
      if (!uri || SAFMode === 'single') {
        return filename;
      }
      return uri;
    }
  }

  #loadCommands() {
    const { editor } = editorManager;
    this.#commands.forEach((command) => {
      editor.commands.addCommand(command);
    });
  }

  #unloadCommands() {
    const { editor } = editorManager;
    this.#commands.forEach((command) => {
      editor.commands.removeCommand(command);
    });
  }

  #defineSnippets(scope, snippets, includeScopes) {
    if (snippets) {
      define(
        `ace/snippets/${scope}.snippets`,
        ["require", "exports", "module"],
        (require, exports, module) => {
          module.exports = snippets;
        }
      );

      define(
        `ace/snippets/${scope}`,
        ["require", "exports", "module", `ace/snippets/${scope}.snippets`],
        (require, exports, module) => {
          exports.snippetText = require(`./${scope}.snippets`);
          exports.scope = scope;
          exports.includeScopes = includeScopes;
        }
      );
    }

    (function () {
      window.require([`ace/snippets/${scope}`], (m) => {
        if (typeof module == "object" && typeof exports == "object" && module) {
          module.exports = m;
        }
      });
    })();
  }

  #joinUrl(path1, path2) {
    if ('joinUrl' in acode) {
      return acode.joinUrl(path1, path2);
    }

    if (path1.endsWith('/') !== path2.startsWith('/')) {
      return path1 + path2;
    } else if (path1.endsWith('/') === path2.startsWith('/')) {
      return path1.slice(0, -1) + path2;
    }

    return `${path1}/${path2}`;
  }

  #saveSnippetLocation(url) {
    appSettings.value[plugin.id] = {
      snippetLocaion: url
    };
    appSettings.update(false);
  }

  #getSnippetLocation() {
    return appSettings.value[plugin.id]?.snippetLocaion || '';
  }

  async #setSnippetPath() {
    const { url } = await acode.fileBrowser('folder', 'select snippet location');

    this.#snippetsLocation = url;
    snippetManager.files = [];
    this.#onChangeMode();

    const fs = acode.fsOperation(url);
    const list = await fs.lsDir();
    if (!list.length) {
      try {
        await this.#copySnippets(url);
        this.#saveSnippetLocation(url);
      } catch (error) {
        acode.alert('ERROR', 'Unable to copy snippets, ' + error.message);
      }
    } else {
      this.#saveSnippetLocation(url);
    }
  }

  async #resetSnippetPath() {
    this.#saveSnippetLocation('');
  }

  async #readFile(url) {
    if (url.startsWith('http')) {
      const { response } = await ajax.get(url, {
        responseType: 'text',
      });
      return response;
    }

    const text = await acode.fsOperation(url).readFile('utf-8');
    return text;
  }

  async #copySnippets(url) {
    const loader = acode.loader('', 'Loading...');
    loader.show();
    await this.#copyRecursive(plugin.files, url, loader)
      .finally(() => {
        loader.destroy();
      });
  }

  async #copyRecursive(files, url, loader) {
    const file = files.shift();
    if (file) await this.#copyFile(file, url, loader);
    if (files.length) await this.#copyRecursive(files, url, loader);
  }

  async #copyFile(file, url, loader) {
    loader.setMessage(`Copying ${file}...`);
    const { response } = await ajax.get(`${this.#baseUrl}${file}`, {
      responseType: 'text'
    });

    const fs = acode.fsOperation(url);
    const filename = file.split('/').pop();
    await fs.createFile(filename, response);
  }

  get #commands() {
    return [
      {
        name: "expandSnippet",
        description: "Expand snippet",
        exec(editor) {
          return snippetManager.expandWithTab(editor);
        },
        bindKey: {
          win: "Tab"
        }
      },
      {
        name: "setSnippetsDirectory",
        description: "Set snippets directory",
        exec: () => {
          this.#setSnippetPath();
        },
      },
      {
        name: "resetSnippetsDirectory",
        description: "Reset snippets directory",
        exec: () => {
          this.#resetSnippetPath();
        },
      }
    ]
  }
}

if (window.acode) {
  const plugin = new AcodeSnippets();
  acode.setPluginInit(pluginId, (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
    plugin.baseUrl = baseUrl;
    plugin.init($page, cacheFile, cacheFileUrl);
  });
  acode.setPluginUnmount(pluginId, () => {
    plugin.destroy();
  });
}