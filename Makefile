# Kagura (神楽) — Declarative UI & 2D Stage Framework Makefile

GEISHA ?= $(shell command -v geisha 2>/dev/null || command -v geisha3 2>/dev/null || ls ../geisha.gsa/build/geisha3 $(HOME)/code/geisha.gsa/build/geisha3 2>/dev/null | head -n 1)
GEISHA_RUNTIME ?= $(shell ls $(dir $(GEISHA))libgeisha_runtime.a ../geisha.gsa/build/libgeisha_runtime.a $(HOME)/code/geisha.gsa/build/libgeisha_runtime.a 2>/dev/null | head -n 1)
GEISHA_WASM_RT ?= $(shell ls $(dir $(GEISHA))wasm_rt.o ../geisha.gsa/build/wasm_rt.o $(HOME)/code/geisha.gsa/build/wasm_rt.o 2>/dev/null | head -n 1)

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
LIB_DIR := $(ROOT_DIR)/lib
BUILD_DIR := $(ROOT_DIR)/build

LIB_SRCS := $(wildcard $(LIB_DIR)/kagura/*.gsa)

WASM_EXPORTS := \
	--export kagura_init \
	--export kagura_step_frame \
	--export kagura_pointer_move \
	--export kagura_pointer_click \
	--export kagura_scroll_wheel \
	--export kagura_text_input \
	--export kagura_text_submit \
	--export kagura_blur_input \
	--export kagura_key_down

.PHONY: all wasm native test serve clean

all: wasm native

wasm: $(BUILD_DIR)/dojo.wasm

$(BUILD_DIR)/dojo.wasm: $(LIB_SRCS) examples/dojo/app.gsa
	@mkdir -p "$(BUILD_DIR)"
	"$(GEISHA)" --target wasm32 -L "$(LIB_DIR)" --runtime "$(GEISHA_WASM_RT)" $(WASM_EXPORTS) -o "$@" examples/dojo/app.gsa

native: $(BUILD_DIR)/kagura-dojo

$(BUILD_DIR)/kagura-dojo: $(LIB_SRCS) examples/dojo/app.gsa host/native/kagura_macos.m
	@mkdir -p "$(BUILD_DIR)"
	# Compile Geisha app with exported entry points (`--target native` emits internal linkage unless promoted in IR)
	"$(GEISHA)" -L "$(LIB_DIR)" -e -o "$(BUILD_DIR)/dojo_native.raw.ll" examples/dojo/app.gsa
	sed -E \
		-e 's/@__geisha_main/@__geisha_kagura_boot/g' \
		-e 's/^define internal void @__geisha_kagura_boot\(\)/define void @__geisha_kagura_boot()/' \
		-e 's/^define i32 @main\(/define internal i32 @__geisha_unused_main(/' \
		-e 's/^define internal ([^@]+@kagura_)/define \1/' \
		"$(BUILD_DIR)/dojo_native.raw.ll" > "$(BUILD_DIR)/dojo_native.ll"
	rm -f "$(BUILD_DIR)/dojo_native.raw.ll"
	MACOSX_DEPLOYMENT_TARGET=14.0 cc -target arm64-apple-macosx14.0 -O2 -Wno-override-module -x ir -c "$(BUILD_DIR)/dojo_native.ll" -o "$(BUILD_DIR)/dojo_app.o"
	rm -f "$(BUILD_DIR)/dojo_native.ll"
	MACOSX_DEPLOYMENT_TARGET=14.0 cc -target arm64-apple-macosx14.0 -O2 -fobjc-arc -Wall -Wextra \
		host/native/kagura_macos.m "$(BUILD_DIR)/dojo_app.o" "$(GEISHA_RUNTIME)" \
		-framework Cocoa -framework QuartzCore -pthread -o "$@"

$(BUILD_DIR)/kagura-spec: $(LIB_SRCS) tests/spec.gsa
	@mkdir -p "$(BUILD_DIR)"
	"$(GEISHA)" -L "$(LIB_DIR)" --runtime "$(GEISHA_RUNTIME)" -o "$@" tests/spec.gsa

test: $(BUILD_DIR)/kagura-spec wasm native
	"$(BUILD_DIR)/kagura-spec"
	"$(BUILD_DIR)/kagura-dojo" --headless-smoke

serve: wasm
	python3 -m http.server 8090 --directory "$(ROOT_DIR)"

clean:
	rm -rf "$(BUILD_DIR)"
