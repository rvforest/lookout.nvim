vim.opt.rtp:append(vim.env.LOOKOUT_ROOT or vim.fn.getcwd())
vim.cmd('runtime plugin/lookout.lua')
local review = require('lookout')
local function check(value, message) if not value then error(message or 'assertion failed') end end
local function wait(checker, message)
  check(vim.wait(15000, checker, 20), message or 'timed out')
end
local errors = {}
vim.notify = function(text, level) if level == vim.log.levels.ERROR then table.insert(errors, text) end end
vim.ui.select = function(items, _, callback)
  local chosen = items[1]
  for _, item in ipairs(items) do if type(item) == 'table' and item.changeKind == 'uncommitted' then chosen = item end end
  callback(chosen)
end
vim.ui.input = function(_, callback) callback('Simplify this constant') end
review.setup({ hosts = { fixture = { url = vim.env.LOOKOUT_TEST_URL, token_env = 'LOOKOUT_TEST_TOKEN' } },
  state_dir = vim.env.LOOKOUT_TEST_STATE })

local function run()
  local original_tab = vim.api.nvim_get_current_tabpage()
  review.connect('fixture')
  local runtime = review._runtime
  wait(function() return runtime.view.files and #runtime.view.files > 0 end, 'No diff snapshot: ' .. table.concat(errors, '; '))
  check(runtime.tab ~= original_tab, 'review should open a dedicated tab')
  check(vim.bo[runtime.beforebuf].modifiable == false, 'before must be read-only')
  check(vim.wo[runtime.after].diff, 'native diff must be enabled')
  check(vim.api.nvim_buf_get_lines(runtime.afterbuf, 0, 1, false)[1] == 'export const count = 2;', 'wrong snapshot content')
  check(vim.api.nvim_buf_get_lines(runtime.beforebuf, 0, 1, false)[1] == 'export const count = 1;', 'wrong original content')
  vim.api.nvim_set_current_win(runtime.after)
  review.comment(1, 1)
  wait(function() return runtime.view.notes and #runtime.view.notes == 1 end)
  check(runtime.view.notes[1].quote == 'export const count = 2;', 'comment should quote selected snapshot')
  review.feedback()
  wait(function() return runtime.feedbackbuf ~= nil end)
  local text = table.concat(vim.api.nvim_buf_get_lines(runtime.feedbackbuf, 0, -1, false), '\n')
  check(text:find('Simplify this constant', 1, true), 'feedback should collect comments')
  vim.cmd('write')
  local acknowledged = false
  review._request('send', { text = text }, function(_, err) check(not err, err); acknowledged = true end)
  wait(function() return acknowledged and runtime.view.delivery and runtime.view.delivery.state == 'accepted' end, 'feedback not accepted')
  check(#runtime.view.notes == 0, 'accepted notes should be cleared')
  vim.api.nvim_set_current_win(runtime.after)
  local seen = false
  review._request('seen', { id = runtime.selected }, function(_, err) check(not err, err); seen = true end)
  wait(function() return seen and #runtime.view.files == 0 end)
  review._request('view', { mode = 'all' })
  wait(function() return runtime.view.mode == 'all' and #runtime.view.files == 1 end)
  check(vim.api.nvim_buf_get_lines(runtime.beforebuf, 0, 1, false)[1] == 'export const count = 1;', 'all view should preserve original baseline')
  vim.api.nvim_set_current_win(runtime.sidebar)
  vim.cmd('tabclose')
  check(vim.api.nvim_get_current_tabpage() == original_tab, 'closing should return to previous workspace')
  check(runtime.job ~= nil, 'closing review should keep observation connected')
  review.open()
  check(vim.api.nvim_tabpage_is_valid(runtime.tab), 'review should reopen')
  check(#errors == 0, table.concat(errors, '; '))
end

local ok, failure = xpcall(run, debug.traceback)
if not ok then io.stderr:write(failure .. '\n'); vim.cmd('cquit 1') end
io.stdout:write('Neovim review flow passed\n')
vim.cmd('qa!')
