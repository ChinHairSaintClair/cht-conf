const fs = require('./sync-fs');
const log = require('./log');

module.exports = (formsDir, extensions, options) => {
  const candidateFiles = fs.readdir(formsDir)
    .filter(name => extensions.find(ext => name.endsWith(ext)));
  
  const formAllowList = options && options.forms && options.forms.filter(form => !form.startsWith('--'));
  if (!formAllowList || !formAllowList.length) {
    return candidateFiles;
  }

  const filteredFiles = candidateFiles.filter(name => formAllowList.includes(fs.withoutExtension(name)));
  if (candidateFiles.length && !filteredFiles.length) {
    const exts = extensions.join(', ');
    log.warn(
      'No files matching the allowed forms were found. Looked for: '+
        `${formAllowList.join(', ')} with extension(s): ${exts}`
    );
  }

  return filteredFiles;
};
