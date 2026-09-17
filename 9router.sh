#!/bin/bash
mkdir -p "$HOME/workspace/.9router"
ln -sfn "$HOME/workspace/.9router" "$HOME/.9router"
exec 9router -n -l --skip-update
