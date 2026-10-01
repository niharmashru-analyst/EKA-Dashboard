# Quantity Entry Fix

The SKU quantity inputs no longer rebuild the entire entry table while typing.

Previous behavior: every input triggered a delayed `render()`, and `change` also rendered immediately. On Android/mobile this could dismiss the keyboard, move the row, and appear as a refresh.

New behavior: input updates the in-memory row and visible totals only. Sorting/rendering happens only after the user leaves the quantity fields, and not when moving directly between Stock and Tester inputs.
