local M = {}
function M.check()
  vim.health.start('Lookout')
  if vim.fn.has('nvim-0.11') == 1 then vim.health.ok('Neovim 0.11+') else vim.health.error('Neovim 0.11+ is required') end
  local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2))))
  if vim.fn.filereadable(root .. '/dist/helper.mjs') == 1 then vim.health.ok('Bundled helper found') else vim.health.error('Run npm ci && npm run build in the plugin directory') end
  if vim.fn.executable('node') == 1 then
    local result = vim.system({ 'node', '--version' }, { text = true }):wait()
    local major = tonumber((result.stdout or ''):match('v(%d+)')) or 0
    if major >= 24 then vim.health.ok('Node ' .. vim.trim(result.stdout)) else vim.health.error('Node.js 24+ is required') end
  else vim.health.error('Node.js is missing from PATH') end
end
return M
