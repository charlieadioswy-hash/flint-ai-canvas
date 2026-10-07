// Package moderation isolates image detector protocols and report aggregation.
package moderation

import (
	"context"
	"errors"
	"sort"
)

type Config struct {
	Type               string
	Region             string
	AccessKeyID        string
	AccessKeySecret    string
	Services           []string
	TimeoutSeconds     int
	MaxCallsPerDay     int
	MinIntervalSeconds int
}

type Image struct {
	Data        []byte
	Name        string
	ContentType string
}
type RiskTag struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Level string `json:"level"`
}
type Result struct {
	RiskLevel string
	RiskTags  []RiskTag
	RequestID string
}
type ItemResult struct {
	Service string
	Result  Result
	Err     error
}
type Summary struct {
	Status    string
	RiskLevel string
	RiskTags  []RiskTag
	Message   string
}

type Provider interface {
	Validate(Config) error
	Detect(context.Context, Config, Image, string) (Result, error)
}

type ServiceDescriptor struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}
type RegionDescriptor struct {
	Value string `json:"value"`
	Label string `json:"label"`
}
type ProviderType struct {
	Type     string              `json:"type"`
	Label    string              `json:"label"`
	Services []ServiceDescriptor `json:"services"`
	Regions  []RegionDescriptor  `json:"regions"`
}

func SupportedTypes() []ProviderType {
	return []ProviderType{{Type: "aliyun", Label: "阿里云", Services: []ServiceDescriptor{
		{Code: "aigcCheck", Label: "AIGC 图片内容风险"},
		{Code: "aigcViolationDetection", Label: "疑似侵权元素（公测）"},
	}, Regions: []RegionDescriptor{{Value: "cn-shanghai", Label: "上海"}, {Value: "cn-beijing", Label: "北京"}}}}
}

func NewProvider(kind string) (Provider, error) {
	if kind != "aliyun" {
		return nil, errors.New("不支持的图片检测平台")
	}
	return newAliyunProvider(), nil
}

func riskOrder(level string) int {
	switch level {
	case "none":
		return 0
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	default:
		return -1
	}
}

// A missing or failed detector is not a clean result. Reports contain only this
// batch's findings; old reports and unrelated confidence scales are not merged.
func Aggregate(items []ItemResult) Summary {
	summary := Summary{Status: "failed", RiskLevel: "unknown", RiskTags: []RiskTag{}, Message: "检测失败，请稍后重试"}
	succeeded, highest := 0, "none"
	tags := make(map[string]RiskTag)
	for _, item := range items {
		if item.Err != nil || riskOrder(item.Result.RiskLevel) < 0 {
			continue
		}
		succeeded++
		if riskOrder(item.Result.RiskLevel) > riskOrder(highest) {
			highest = item.Result.RiskLevel
		}
		for _, tag := range item.Result.RiskTags {
			if tag.Code == "" || tag.Label == "" || riskOrder(tag.Level) <= 0 {
				continue
			}
			if old, ok := tags[tag.Code]; !ok || riskOrder(tag.Level) > riskOrder(old.Level) {
				tags[tag.Code] = tag
			}
		}
	}
	if succeeded == 0 {
		return summary
	}
	for _, tag := range tags {
		summary.RiskTags = append(summary.RiskTags, tag)
	}
	sort.Slice(summary.RiskTags, func(i, j int) bool {
		a, b := summary.RiskTags[i], summary.RiskTags[j]
		if riskOrder(a.Level) != riskOrder(b.Level) {
			return riskOrder(a.Level) > riskOrder(b.Level)
		}
		return a.Code < b.Code
	})
	summary.RiskLevel = highest
	if succeeded != len(items) {
		summary.Status = "partial"
		if highest == "none" {
			summary.RiskLevel = "unknown"
			summary.Message = "部分检测未完成，暂时无法给出完整结论"
		} else {
			summary.Message = "检测到风险，部分检测尚未完成"
		}
		return summary
	}
	summary.Status = "completed"
	switch highest {
	case "none":
		summary.Message = "检测已完成，当前图片未检测到风险"
	case "low":
		summary.Message = "检测到低风险，请查看风险详情"
	case "medium":
		summary.Message = "检测到中风险，建议人工复核"
	case "high":
		summary.Message = "检测到高风险，请查看风险详情"
	}
	return summary
}
