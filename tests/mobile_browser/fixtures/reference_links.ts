export const SCHEME_LINKS = `[Email](mailto:reader@example.com) · [Phone](tel:+15551234567) · [Local file](file:///tmp/example) · [Open editor](vscode://file/x) · [Notes](obsidian://open?vault=notes) · [Chat](slack://open) · [FTP](ftp://files.example/report) · [Custom script name](otherscript:open)

[Unsafe script](javascript:alert(1)) · [Unsafe vbscript](vbscript:msgbox(1)) · [Unsafe data](data:text/html,blocked)`;

export const REFERENCE_LINKS = `## References

1. <a id="cite_note-20"></a>Saunders LM, Srivatsan SR, Duran M, et al. (2023). "Embryo-scale reverse genetics at single-cell resolution". *Nature*. 623: 782–791. [doi](https://doi.org/10.1038/s41586-023-06720-2):[10.1038/s41586-023-06720-2](https://doi.org/10.1038/s41586-023-06720-2).
2. <a name="cite_note-21"></a>Wang C, Karthikeyan M, Ravindra NG, et al. (2026). "X-Cell: Scaling Causal Perturbation Prediction". *bioRxiv*. [Nature](https://www.nature.com/), [doi.org](https://doi.org/), [https://doi.org/](https://doi.org/).

<a href="">Empty target</a> · [Reference 20](#cite_note-20) · [Reference 21](#cite_note-21)

${SCHEME_LINKS}

[https://good.example](https://evil.example/) · [good.example/path](https://evil.example/) · [https://good.example/relative](//evil.example/) · [https://good.example/credentials](https://user@evil.example/)
`;
