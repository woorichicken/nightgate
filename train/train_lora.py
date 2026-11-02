"""LoRA fine-tune of Muse Glimmer on the human's morning decisions.

Input:  train.jsonl from `nightgate dataset` — one {"messages": [system, user, assistant]} per line,
        where the assistant turn is the human's label as the judge's JSON answer.
Output: a LoRA adapter directory, plus a status JSON the console shows under "Last LoRA run".

Not yet run end to end. Before the first run on a DGX Spark (GB10, 121 GB unified memory):
  - needs transformers >= 5.15 (older versions do not know the muse_glimmer architecture),
    peft and trl, and the bf16 checkpoint: hf download meta-models/Muse-Glimmer-30B
  - plain bf16 LoRA (no 4-bit): ~60 GB of weights fits in unified memory, and 4-bit kernels
    may not exist for this GPU yet.

Usage:
  python train/train_lora.py --model ./muse-glimmer-bf16 --data ~/.nightgate/training/train.jsonl \
      --out ./runs/judge-lora --status ~/.nightgate/training/run-latest.json
"""

import argparse
import json
import re
import time
from pathlib import Path

# Only the language model's linear layers; the vision tower stays frozen.
TARGET_PATTERN = r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$"


def write_status(path: Path, **fields) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fields, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--epochs", type=float, default=3)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-4)
    args = parser.parse_args()

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForImageTextToText, AutoTokenizer, TrainerCallback
    from trl import SFTConfig, SFTTrainer

    status_path = Path(args.status).expanduser()
    started = time.time()
    dataset = load_dataset("json", data_files=str(Path(args.data).expanduser()), split="train")
    write_status(status_path, state="loading", rows=len(dataset), model=args.model, startedAt=time.strftime("%FT%T"))

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForImageTextToText.from_pretrained(args.model, dtype=torch.bfloat16, device_map="cuda")

    # Module names come from the checkpoint; refuse to train if the pattern matches nothing
    # rather than silently training zero parameters.
    targets = [name for name, _ in model.named_modules() if re.match(TARGET_PATTERN, name)]
    if not targets:
        sample = [name for name, _ in model.named_modules()][:40]
        raise SystemExit(f"LoRA target pattern matched no modules. First modules: {sample}")
    print(f"LoRA on {len(targets)} modules")

    class StatusCallback(TrainerCallback):
        def on_log(self, _args, state, _control, logs=None, **_kwargs):
            write_status(
                status_path,
                state="training",
                rows=len(dataset),
                step=state.global_step,
                maxSteps=state.max_steps,
                loss=(logs or {}).get("loss"),
                elapsedSec=round(time.time() - started),
            )

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=dataset,
        peft_config=LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, target_modules=TARGET_PATTERN),
        args=SFTConfig(
            output_dir=args.out,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            gradient_checkpointing=True,
            learning_rate=args.lr,
            bf16=True,
            logging_steps=1,
            save_strategy="epoch",
            # Learn the answer, not the prompt: the system/user turns are the same template every time.
            assistant_only_loss=True,
            report_to=[],
        ),
        callbacks=[StatusCallback()],
    )
    trainer.train()
    trainer.save_model(args.out)
    write_status(
        status_path,
        state="done",
        rows=len(dataset),
        adapter=str(Path(args.out).resolve()),
        elapsedSec=round(time.time() - started),
        finishedAt=time.strftime("%FT%T"),
    )


if __name__ == "__main__":
    main()
