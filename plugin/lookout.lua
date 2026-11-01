if vim.g.loaded_lookout then return end
vim.g.loaded_lookout = true
vim.api.nvim_create_user_command('Lookout', function(opts)
  require('lookout').command(opts)
end, {
  nargs = '*', range = true,
  complete = function(arglead)
    return vim.tbl_filter(function(value) return vim.startswith(value, arglead) end,
      { 'connect', 'open', 'refresh', 'comment', 'seen', 'feedback', 'disconnect', 'sessions', 'scope', 'all', 'since', 'clear', 'help' })
  end,
  desc = 'Follow and review an AHP agent session',
})
